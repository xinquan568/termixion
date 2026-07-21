// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the persisted-settings registry — the one enumerable place every user-visible setting
// lives (key, default, parse), generalizing trmx-48's single-key autoCheckStore. Because the
// registry is enumerable, "Reset all settings" restores *everything* by construction, and each
// write/reset broadcasts `settings:changed` over an injected bus so other windows (the live
// terminal in the main window) apply changes immediately.
//
// trmx-53 adds appearance.theme — the registry's ONE dynamic default: with no persisted value it
// derives from the OS appearance (defaultThemeId: dark → night, light → catppuccin-latte) and materializes
// (writes back) so the OS is consulted only once; Reset all removes the key, so a post-reset read
// re-derives like a fresh first run, and the reset broadcast carries the derived value.
//
// trmx-80 (FR-13): the VALUE backend is no longer localStorage. All storage-less
// makeSettingsStore() instances (every production call site) share one MODULE-LEVEL snapshot,
// hydrated once at boot from the backend's TOML config file (`config_read`, see docs/config.md);
// writes go through `config_write` fire-and-forget and reset through `config_reset_all`. The
// snapshot stays live via the `settings:changed` bus (other windows AND the backend's config-file
// watcher, source "config-file"). An EXPLICITLY injected storage keeps the legacy per-instance
// localStorage backend as a compat shim for TESTS — kept deliberately at T3e: many suites (the
// settings-window UI, update mirror/authority, and the terminal option slices) seed stores
// through an injected fakeStorage, and the shim gives them isolated per-instance state.
// `update.lastCheckAt` stays on localStorage forever: it is internal scheduler bookkeeping, not
// user configuration, so it never belongs in the user-facing config file (docs/config.md).
import { defaultThemeId } from "../theme/defaultTheme";
import { isRegisteredThemeId, isUserThemeIdShape } from "../theme/registry";
import { isRemovedBuiltinThemeId, type ThemeId } from "../theme/themes";
import { realInvoke, type InvokeFn } from "../ipc/backend";
import { realEventBus } from "../ipc/eventBus";

/** The minimal Web-Storage slice we depend on (injectable; adds removeItem for reset). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Fire-and-forget event emission (the Tauri `emit` shape; a fake in tests, absent in plain dev). */
export interface SettingsBus {
  emit(event: string, payload: unknown): unknown;
}

/** The listen-capable bus slice hydrateSettings subscribes on (the Tauri `listen` shape). */
export interface SettingsListenBus {
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

/** The event other windows subscribe to for live application of setting changes. */
export const SETTINGS_CHANGED_EVENT = "settings:changed";

/** The backend broadcast carrying a fresh config-file warning set (the file watcher re-parsed). */
export const CONFIG_WARNINGS_EVENT = "config:warnings";

export interface SettingsChanged {
  key: SettingKey;
  value: SettingsValues[SettingKey];
  source: string;
}

export type CheckFrequency = "on-startup" | "daily" | "weekly" | "manual";
export type CursorStyle = "bar" | "block" | "underline";
/** trmx-144: when closing a pane/tab/window asks for confirmation — "when-busy" prompts only
 * while a foreground program is still running (the iTerm2-style default). */
export type ConfirmClose = "never" | "when-busy" | "always";
/** trmx-81 (FR-2.2): the window edge the tab bar sits on. */
export type TabBarPosition = "top" | "bottom" | "left" | "right";
/** trmx-82 (FR-2.3): how the side-rail tab labels run (only meaningful on left/right bars). */
export type LabelOrientation = "horizontal" | "vertical";

/** Every user-visible persisted setting and its type. */
export interface SettingsValues {
  "update.autoCheck": boolean;
  "update.checkFrequency": CheckFrequency;
  "update.autoDownload": boolean;
  "terminal.cursorStyle": CursorStyle;
  "terminal.cursorBlink": boolean;
  /** trmx-144: confirm before closing a pane, a tab, or quitting (default "when-busy"). */
  "terminal.confirmClose": ConfirmClose;
  /** trmx-91: show the per-pane activity line while a session runs a foreground job. */
  "terminal.activityIndicator": boolean;
  /** trmx-95: auto-copy the mouse selection to the clipboard, iTerm2-style (default on). */
  "terminal.copyOnSelect": boolean;
  /** trmx-80 (FR-13): scrollback capacity in lines (was the fixed SCROLLBACK_LINES constant). */
  "terminal.scrollbackLines": number;
  /** trmx-80 (FR-13): terminal font family; "" means "use the platform default stack". */
  "terminal.fontFamily": string;
  /** trmx-80 (FR-13): terminal font size in points. */
  "terminal.fontSize": number;
  "appearance.theme": ThemeId;
  /** trmx-81 (FR-2.2): where the tab bar lives (mirrors core's `tabs.bar_position`). */
  "tabs.barPosition": TabBarPosition;
  /**
   * trmx-82 (FR-2.3): side-rail label orientation (mirrors core's `tabs.side_label_orientation`).
   * Registry-stored unconditionally; App gates the EFFECT to left/right bars (labelOrientationFor).
   */
  "tabs.sideLabelOrientation": LabelOrientation;
  /** trmx-151: show the ⌘1–⌘9 shortcut hints before the first nine tab titles (default on). A
   * plain boolean like terminal.activityIndicator — the strip gates only the RENDER; the chords
   * themselves stay bound either way (mirrors core's `tabs.show_shortcut_hints`). */
  "tabs.showShortcutHints": boolean;
  /** trmx-190: show the live AI-session counters in the title bar's right slot (default on). A
   * plain boolean render gate like terminal.activityIndicator (mirrors core's `title_bar.ai_counter`). */
  "titleBar.aiCounter": boolean;
  /** trmx-93 (FR-5): the startup script to source in the first tab on launch, as a scripts-root
   * relative path (e.g. "work/proj-x.sh"); "" = none. A free string, like terminal.fontFamily. */
  "scripts.startup": string;
  /** trmx-205: the shell new sessions spawn — "" = System default ($SHELL chain); else an
   * absolute path to an installed shell. A free string like terminal.fontFamily; validated
   * impurely by the backend (spawn falls back + warns on an invalid path). */
  "terminal.shell": string;
  /** trmx-101 (FR-9.4): the external control channel — OFF by default; a local socket that lets scripts
   * drive the terminal. `socketPath` "" = the default path. The socket itself lives in the Rust shell. */
  "remote_control.enabled": boolean;
  "remote_control.socketPath": string;
}

export type SettingKey = keyof SettingsValues;

/**
 * The clamp ranges for the number-typed settings — mirrors termixion-core's ranges, see
 * docs/config.md. Values are clamped on read/write; the backend clamps too (OutOfRange warning),
 * this is the client's defensive copy of the same contract.
 */
export const SETTING_RANGES = {
  "terminal.scrollbackLines": { min: 0, max: 200_000 },
  "terminal.fontSize": { min: 6, max: 72 },
} as const;

type NumberSettingKey = keyof typeof SETTING_RANGES;

/** Clamp a number-typed setting's value into its registry range. */
export function clampNumberSetting(key: NumberSettingKey, value: number): number {
  const { min, max } = SETTING_RANGES[key];
  return Math.min(max, Math.max(min, value));
}

/**
 * trmx-51 defaults: auto-check on, check on startup, auto-download on, underline cursor.
 * trmx-55: cursor blink defaults OFF (iTerm2-default parity — iTerm2 ships a solid, non-blinking
 * cursor; see iterm2Theme.ts). Users who want blinking keep the toggle.
 * trmx-80: scrollback 10k (the trmx-65 constant, now a setting), fontSize 12 (the iTerm2 default).
 * trmx-204: fontFamily defaults to the bundled SauceCodePro Nerd Font Mono face (fontCatalog.ts);
 * "" remains the explicit System-default sentinel (= the platform stack at the chokepoint).
 */
export const SETTING_DEFAULTS: SettingsValues = {
  "update.autoCheck": true,
  "update.checkFrequency": "on-startup",
  "update.autoDownload": true,
  "terminal.cursorStyle": "underline",
  "terminal.cursorBlink": false,
  // trmx-144: prompt only when a program is still running (iTerm2-style default).
  "terminal.confirmClose": "when-busy",
  // trmx-91: the activity line is ON by default (off keeps the poller running for titles).
  "terminal.activityIndicator": true,
  // trmx-95: auto-copy selection ON by default (iTerm2 parity).
  "terminal.copyOnSelect": true,
  "terminal.scrollbackLines": 10_000,
  "terminal.fontFamily": "SauceCodePro Nerd Font Mono",
  "terminal.fontSize": 12,
  // trmx-53: static placeholder only — appearance.theme is the registry's one DYNAMIC default;
  // every real read goes through defaultFor(), which derives from the OS appearance instead.
  "appearance.theme": "white",
  // trmx-81 (FR-2.2): the vision default — the bar sits along the window's bottom edge.
  "tabs.barPosition": "bottom",
  // trmx-82 (FR-2.3): side-rail labels stay readable by default; rotation is an opt-in.
  "tabs.sideLabelOrientation": "horizontal",
  // trmx-151: the ⌘N tab hints are ON by default (iTerm2 parity); off is a visual opt-out only.
  "tabs.showShortcutHints": true,
  // trmx-190: the AI-session counter is ON by default (off is a render gate only).
  "titleBar.aiCounter": true,
  // trmx-93 (FR-5): no startup script by default (empty = none).
  "scripts.startup": "",
  "terminal.shell": "",
  "remote_control.enabled": false,
  "remote_control.socketPath": "",
};

/**
 * The effective default for a key. Static from SETTING_DEFAULTS for every key except
 * appearance.theme, whose first-run value derives from the OS appearance (trmx-53).
 */
function defaultFor<K extends SettingKey>(key: K): SettingsValues[K] {
  if (key === "appearance.theme") return defaultThemeId() as SettingsValues[K];
  return SETTING_DEFAULTS[key];
}

// LEGACY localStorage keys (the trmx-48/51 backend). Since trmx-80 these exist for two purposes
// only: the one-time migration into the config file (hydrateSettings) and the injected-storage
// compat shim. The trmx-48 auto-check key is kept verbatim so existing installs keep their choice.
const STORAGE_KEYS: Record<SettingKey, string> = {
  "update.autoCheck": "termixion.update.autoCheck",
  "update.checkFrequency": "termixion.update.checkFrequency",
  "update.autoDownload": "termixion.update.autoDownload",
  "terminal.cursorStyle": "termixion.terminal.cursorStyle",
  "terminal.cursorBlink": "termixion.terminal.cursorBlink",
  // trmx-144: never existed pre-config-file, so the T3b migration finds nothing — harmless.
  "terminal.confirmClose": "termixion.terminal.confirmClose",
  "terminal.activityIndicator": "termixion.terminal.activityIndicator",
  "terminal.copyOnSelect": "termixion.terminal.copyOnSelect",
  "terminal.scrollbackLines": "termixion.terminal.scrollbackLines",
  "terminal.fontFamily": "termixion.terminal.fontFamily",
  "terminal.fontSize": "termixion.terminal.fontSize",
  "appearance.theme": "termixion.appearance.theme",
  // trmx-81/82/151: never existed pre-config-file, so the T3b migration finds nothing — harmless.
  "tabs.barPosition": "termixion.tabs.barPosition",
  "tabs.sideLabelOrientation": "termixion.tabs.sideLabelOrientation",
  "tabs.showShortcutHints": "termixion.tabs.showShortcutHints",
  // trmx-190: never existed pre-config-file, so the T3b migration finds nothing — harmless.
  "titleBar.aiCounter": "termixion.titleBar.aiCounter",
  // trmx-93 (FR-5): never existed pre-config-file, so the migration finds nothing — harmless.
  "scripts.startup": "termixion.scripts.startup",
  "terminal.shell": "termixion.terminal.shell",
  "remote_control.enabled": "termixion.remote_control.enabled",
  "remote_control.socketPath": "termixion.remote_control.socketPath",
};

// Internal scheduler bookkeeping (NOT a user-visible setting, NOT config-file material — see
// docs/config.md): stays on localStorage forever, is never migrated, still cleared by reset.
const LAST_CHECK_AT_KEY = "termixion.update.lastCheckAt";

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

const FREQUENCIES: readonly CheckFrequency[] = ["on-startup", "daily", "weekly", "manual"];
const CURSOR_STYLES: readonly CursorStyle[] = ["bar", "block", "underline"];
const CONFIRM_CLOSE_VALUES: readonly ConfirmClose[] = ["never", "when-busy", "always"];
const TAB_BAR_POSITIONS: readonly TabBarPosition[] = ["top", "bottom", "left", "right"];
const LABEL_ORIENTATIONS: readonly LabelOrientation[] = ["horizontal", "vertical"];

/** Type guard for tabs.barPosition values (trmx-81) — App's payload guard uses it too. */
export function isTabBarPosition(value: unknown): value is TabBarPosition {
  return typeof value === "string" && TAB_BAR_POSITIONS.includes(value as TabBarPosition);
}

/** Type guard for tabs.sideLabelOrientation values (trmx-82) — App's payload guard uses it too. */
export function isLabelOrientation(value: unknown): value is LabelOrientation {
  return typeof value === "string" && LABEL_ORIENTATIONS.includes(value as LabelOrientation);
}

// trmx-55: booleans are default-aware — only the "true"/"false" literals parse; anything else
// falls back to the key's default, matching the enums (and the registry contract: default when
// unset, unparseable, or storage is unavailable). trmx-80 adds the number branch: numbers are
// INTEGERS ONLY (the backend's config_write contract) — junk, the empty string, and fractional
// values all → default; integer values are CLAMPED into the registry range.
function parse<K extends SettingKey>(key: K, raw: string): SettingsValues[K] {
  const fallback = SETTING_DEFAULTS[key];
  if (typeof fallback === "boolean") {
    if (raw === "true") return true as SettingsValues[K];
    if (raw === "false") return false as SettingsValues[K];
    return fallback as SettingsValues[K];
  }
  if (typeof fallback === "number") {
    // Number("") === 0, so an empty/whitespace raw must be rejected before conversion.
    const n = raw.trim() === "" ? NaN : Number(raw);
    // Number.isInteger rejects NaN/±Infinity AND fractional values in one check.
    if (!Number.isInteger(n)) return fallback as SettingsValues[K];
    return clampNumberSetting(key as NumberSettingKey, n) as SettingsValues[K];
  }
  if (key === "update.checkFrequency") {
    return (FREQUENCIES.includes(raw as CheckFrequency)
      ? raw
      : fallback) as SettingsValues[K];
  }
  if (key === "appearance.theme") {
    // trmx-53: junk falls back to the DERIVED default (read-time fallback, not a repair).
    // trmx-89 C1: a registered id OR a shape-valid `user:<stem>` id is kept (a persisted user
    // theme survives even before the registry scan resolves); anything else re-derives.
    return (isRegisteredThemeId(raw) || isUserThemeIdShape(raw)
      ? raw
      : defaultFor(key)) as SettingsValues[K];
  }
  if (key === "terminal.fontFamily") {
    // A free-form string: any value is a valid font stack ("" = platform default).
    return raw as SettingsValues[K];
  }
  if (key === "scripts.startup") {
    // trmx-93: a free-form scripts-root relative path ("" = none); validated at launch, not here.
    return raw as SettingsValues[K];
  }
  if (key === "terminal.shell") {
    // trmx-205: a free-form shell path ("" = System default); validated by the backend at
    // spawn/read time, never here.
    return raw as SettingsValues[K];
  }
  if (key === "tabs.barPosition") {
    // trmx-81: enum parse-with-fallback, exactly like terminal.cursorStyle below.
    return (isTabBarPosition(raw) ? raw : fallback) as SettingsValues[K];
  }
  if (key === "tabs.sideLabelOrientation") {
    // trmx-82: enum parse-with-fallback, mirroring tabs.barPosition above.
    return (isLabelOrientation(raw) ? raw : fallback) as SettingsValues[K];
  }
  if (key === "terminal.confirmClose") {
    // trmx-144: enum parse-with-fallback, exactly like terminal.cursorStyle below.
    return (CONFIRM_CLOSE_VALUES.includes(raw as ConfirmClose)
      ? raw
      : fallback) as SettingsValues[K];
  }
  return (CURSOR_STYLES.includes(raw as CursorStyle) ? raw : fallback) as SettingsValues[K];
}

/**
 * Validate an UNTRUSTED typed value (config_read seeding, settings:changed payloads, set()):
 * booleans must be boolean, enums must be members, numbers INTEGERS (then CLAMPED — trmx-80
 * review R4: the backend's config_write rejects fractional numbers, so they are invalid here
 * too), strings string. Returns undefined when the value is unusable for the key — callers
 * decide the fallback (reject the write, serve the default, record a client warning).
 */
function coerce<K extends SettingKey>(key: K, value: unknown): SettingsValues[K] | undefined {
  const fallback = SETTING_DEFAULTS[key];
  if (typeof fallback === "boolean") {
    return typeof value === "boolean" ? (value as SettingsValues[K]) : undefined;
  }
  if (typeof fallback === "number") {
    // Number.isInteger rejects NaN/±Infinity AND fractional values in one check.
    if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
    return clampNumberSetting(key as NumberSettingKey, value) as SettingsValues[K];
  }
  if (typeof value !== "string") return undefined;
  if (key === "update.checkFrequency") {
    return FREQUENCIES.includes(value as CheckFrequency) ? (value as SettingsValues[K]) : undefined;
  }
  if (key === "appearance.theme") {
    // trmx-89 C1: accept a REGISTERED id (built-in or a resolved user theme) OR a shape-valid
    // `user:<stem>` id. The shape branch is load-bearing: themes_read() populates the registry
    // AFTER boot, so a persisted user id would otherwise be coerced back to a built-in default on
    // the pre-scan read/seed. resolveTheme() serves the derived default for it until the scan resolves (trmx-202); a truly
    // junk value (wrong type, "neon", "__proto__") still fails both guards and is rejected.
    return isRegisteredThemeId(value) || isUserThemeIdShape(value)
      ? (value as SettingsValues[K])
      : undefined;
  }
  if (key === "terminal.fontFamily") return value as SettingsValues[K];
  if (key === "scripts.startup") return value as SettingsValues[K];
  if (key === "terminal.shell") return value as SettingsValues[K]; // trmx-205
  if (key === "tabs.barPosition") {
    return isTabBarPosition(value) ? (value as SettingsValues[K]) : undefined;
  }
  if (key === "tabs.sideLabelOrientation") {
    return isLabelOrientation(value) ? (value as SettingsValues[K]) : undefined;
  }
  if (key === "terminal.confirmClose") {
    return CONFIRM_CLOSE_VALUES.includes(value as ConfirmClose)
      ? (value as SettingsValues[K])
      : undefined;
  }
  return CURSOR_STYLES.includes(value as CursorStyle) ? (value as SettingsValues[K]) : undefined;
}

function serialize(value: SettingsValues[SettingKey]): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return value;
}

// ---------------------------------------------------------------------------------------------
// trmx-80: the backend config-file contract (T2) and the warning surface for the settings UI.
// ---------------------------------------------------------------------------------------------

/** One warning from the backend's config-file parse (the T2 `config_read` / watcher contract). */
export type ConfigWarningPayload =
  | { type: "SyntaxError"; message: string }
  | { type: "UnknownKey"; key: string }
  | { type: "InvalidValue"; key: string; got: string; expected: string }
  | { type: "OutOfRange"; key: string; got: number; clamped_to: number };

/**
 * One human-readable warning for the settings UI (T3e). `file` = rendered from a backend payload
 * (syntax/unknown-key/invalid/out-of-range in the TOML); `client` = authored here, when a
 * config-origin value failed the registry's own per-key validation.
 */
export interface ConfigWarningItem {
  source: "file" | "client";
  message: string;
}

/** Render a backend warning payload human-readably (defensive: junk shapes get a generic line). */
function renderConfigWarning(payload: unknown): string {
  const w = payload as Partial<
    { type: string; message: string; key: string; got: unknown; expected: string; clamped_to: unknown }
  > | null;
  switch (w?.type) {
    case "SyntaxError":
      return `Config file syntax error: ${w.message ?? "unknown error"}`;
    case "UnknownKey":
      return `Unknown setting "${w.key ?? "?"}" in the config file (ignored)`;
    case "InvalidValue":
      return `Invalid value for "${w.key ?? "?"}" in the config file: got ${String(
        w.got,
      )}, expected ${w.expected ?? "?"}`;
    case "OutOfRange":
      return `Value for "${w.key ?? "?"}" is out of range: ${String(w.got)} (clamped to ${String(
        w.clamped_to,
      )})`;
    default:
      return `Config file warning: ${JSON.stringify(payload)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Module state: the shared snapshot + the config metadata (path, warnings) + the write channel.
// Module-scope BY DESIGN: SettingsWindowHost/UpdateAuthorityHost construct their stores at module
// scope, before hydration — construction only closes over this state, so it is always safe, and
// pre-hydration reads simply fall through to defaultFor().
// ---------------------------------------------------------------------------------------------

const snapshot = new Map<SettingKey, SettingsValues[SettingKey]>();
let configPath: string | null = null;
// trmx-80 review R2 (round 2): FILE and CLIENT warnings are SEPARATE ledgers. The backend's
// config:warnings event describes only what the CORE parser can see, so it replaces the FILE set
// wholesale (including with the empty set) — it must never wipe a CLIENT warning it cannot know
// about (e.g. an invalid theme id: a free string to the backend, validated only here). A client
// warning is keyed by its registry key and superseded only by a NEW VALUE for that same key:
// invalid → (re)set, valid → cleared.
let fileWarnings: ConfigWarningItem[] = [];
const clientWarnings = new Map<SettingKey, ConfigWarningItem>();
// The invoke used for config_write/config_reset_all after (or before) hydration. hydrateSettings
// swaps in its injected invoke so every store instance writes through the same channel.
let configInvoke: InvokeFn = realInvoke;
let busSubscribed = false;
const busUnlistens: Array<() => void> = [];

/** Invoke defensively: a missing Tauri runtime throws SYNCHRONOUSLY — normalize to a rejection. */
function invokeSafely(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  try {
    return Promise.resolve(configInvoke(cmd, args));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** The absolute path of the backend config file, once hydrated (null before / without a backend). */
export function getConfigFilePath(): string | null {
  return configPath;
}

/**
 * trmx-148: open the config file in its OS default application — the About row's BACKEND-side
 * open (the webview opener plugin command is capability-denied in the packaged app; this mirrors
 * the themes/scripts open-dir seam pattern). Unlike the fire-and-forget config_write path, the
 * rejection PROPAGATES to the caller so the row can surface the failure. Rides the
 * hydration-injected invoke channel automatically.
 */
export function openConfigFile(): Promise<void> {
  return invokeSafely("config_open_file").then(() => {});
}

/** The current config warnings for the settings UI (T3e): the MERGED ledgers, file-rendered
 * warnings first, then the client-authored per-key warnings. */
export function getConfigWarnings(): ConfigWarningItem[] {
  return [...fileWarnings, ...clientWarnings.values()];
}

// trmx-80 review R2: the store is the SINGLE warnings authority. The UI subscribes here rather
// than to the raw config:warnings event, so it observes EVERY change: backend re-parses
// (including the EMPTY set that clears a stale banner) and client-authored warnings (which no
// backend event ever carries).
const configWarningsListeners = new Set<(items: ConfigWarningItem[]) => void>();

/**
 * Subscribe to changes of the stored warnings array (backend `config:warnings` broadcasts —
 * including empty ones — and client-authored warnings alike). The callback receives the fresh
 * full set; the returned function unsubscribes.
 */
export function onConfigWarningsChanged(
  cb: (items: ConfigWarningItem[]) => void,
): () => void {
  configWarningsListeners.add(cb);
  return () => void configWarningsListeners.delete(cb);
}

/** Notify every subscriber that the stored warnings changed (defensive per-listener). */
function publishConfigWarnings(): void {
  const items = getConfigWarnings();
  for (const listener of [...configWarningsListeners]) {
    try {
      listener(items);
    } catch {
      // A throwing subscriber must never break the store or its sibling subscribers.
    }
  }
}

/**
 * Reset ALL module state (snapshot, path, warnings, invoke, bus subscription) — test hygiene for
 * suites that hydrate or write through the shared snapshot. Production never calls this.
 */
export function __resetSettingsForTest(): void {
  snapshot.clear();
  configPath = null;
  fileWarnings = [];
  clientWarnings.clear();
  configWarningsListeners.clear();
  configInvoke = realInvoke;
  busSubscribed = false;
  for (const unlisten of busUnlistens.splice(0)) {
    try {
      unlisten();
    } catch {
      // Best-effort teardown.
    }
  }
}

export interface SettingsStore {
  /** Read a setting; defaults when unset, unparseable, or the backend is unavailable. */
  get<K extends SettingKey>(key: K): SettingsValues[K];
  /** Persist a setting and broadcast `settings:changed` (best-effort on both). */
  set<K extends SettingKey>(key: K, value: SettingsValues[K]): void;
  /** The ISO timestamp of the last automatic/manual update check, or null. */
  loadLastCheckAt(): string | null;
  saveLastCheckAt(iso: string): void;
  /**
   * Reset EVERY persisted key (all registered settings + lastCheckAt) and broadcast each
   * user-visible setting's default so every window reverts live.
   */
  resetAll(): void;
}

/**
 * Build the store. WITHOUT a storage argument (every production call site) the store reads and
 * writes the module-level shared snapshot: reads fall back to defaultFor() until hydrateSettings
 * seeds the snapshot from the config file; writes update the snapshot optimistically, persist via
 * `config_write` fire-and-forget, and broadcast. WITH an explicitly injected `storage` the store
 * keeps the legacy per-instance localStorage backend (a compat shim many test suites seed
 * through; kept deliberately at T3e — see the module header).
 * `bus` is optional (plain dev/jsdom have no cross-window bus); `source` tags broadcasts so
 * subscribers can ignore their own echoes.
 */
export function makeSettingsStore(
  storage?: KeyValueStore,
  bus?: SettingsBus,
  source: string = "unknown",
): SettingsStore {
  return storage
    ? makeLegacyStorageStore(storage, bus, source)
    : makeSnapshotStore(bus, source);
}

function makeBroadcast(bus: SettingsBus | undefined, source: string) {
  return (key: SettingKey, value: SettingsValues[SettingKey]) => {
    if (!bus) return;
    try {
      const result = bus.emit(SETTINGS_CHANGED_EVENT, { key, value, source });
      // A rejected promise (e.g. no Tauri runtime) must not surface as an unhandled rejection.
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // Best-effort: broadcasting must never break the write itself.
    }
  };
}

/** trmx-80: the production store over the module-level shared snapshot. */
function makeSnapshotStore(bus: SettingsBus | undefined, source: string): SettingsStore {
  const broadcast = makeBroadcast(bus, source);
  return {
    get(key) {
      if (snapshot.has(key)) return snapshot.get(key) as SettingsValues[typeof key];
      // Not hydrated / not present in the file: the (possibly OS-derived) registry default.
      // Materialization is hydrateSettings' job now — a read never writes.
      return defaultFor(key);
    },
    set(key, value) {
      // Validate/clamp even the typed path (events and JS callers are untrusted at runtime).
      // STRICT REJECTION (trmx-80 review R4, matching the backend contract): an unusable value —
      // wrong type, or a NON-INTEGER for a number key — is dropped whole. It never reaches the
      // snapshot, the broadcast, or config_write (which would refuse it anyway), so the
      // UI/session can never diverge from the file over an invalid write.
      const effective = coerce(key, value);
      if (effective === undefined) {
        console.warn(`[termixion] ignoring invalid value for ${key}:`, value);
        return;
      }
      snapshot.set(key, effective);
      // A valid local write supersedes any client warning for this key (the file gets the
      // valid value; the old "invalid value in the file" complaint no longer applies).
      if (clientWarnings.delete(key)) publishConfigWarnings();
      invokeSafely("config_write", { key, value: effective }).catch((err: unknown) => {
        // Fire-and-forget by contract: the optimistic snapshot value stands for this session;
        // an unwritable config file must never break the control that wrote it.
        console.warn(`[termixion] config_write failed for ${key}`, err);
      });
      broadcast(key, effective);
    },
    loadLastCheckAt() {
      // Internal bookkeeping, NOT user config: stays on localStorage (see docs/config.md).
      const storage = safeLocalStorage();
      if (!storage) return null;
      try {
        return storage.getItem(LAST_CHECK_AT_KEY);
      } catch {
        return null;
      }
    },
    saveLastCheckAt(iso) {
      try {
        safeLocalStorage()?.setItem(LAST_CHECK_AT_KEY, iso);
      } catch {
        // Best-effort.
      }
    },
    resetAll() {
      for (const key of SETTING_KEYS) snapshot.delete(key);
      invokeSafely("config_reset_all").catch((err: unknown) => {
        console.warn("[termixion] config_reset_all failed", err);
      });
      try {
        safeLocalStorage()?.removeItem(LAST_CHECK_AT_KEY);
      } catch {
        // Best-effort.
      }
      for (const key of SETTING_KEYS) {
        // trmx-53: defaultFor, not SETTING_DEFAULTS — appearance.theme's reset broadcast
        // carries the value derived at reset time (a reset behaves like a fresh first run).
        broadcast(key, defaultFor(key));
      }
    },
  };
}

/** The pre-trmx-80 storage-backed store, kept verbatim for explicitly injected storages. */
function makeLegacyStorageStore(
  storage: KeyValueStore,
  bus: SettingsBus | undefined,
  source: string,
): SettingsStore {
  const broadcast = makeBroadcast(bus, source);
  return {
    get(key) {
      try {
        const raw = storage.getItem(STORAGE_KEYS[key]);
        if (raw === null) {
          const value = defaultFor(key);
          // trmx-53: appearance.theme materializes its first-run derivation ("derive once,
          // then persist") so the OS appearance is never consulted again until a reset.
          if (key === "appearance.theme") {
            try {
              storage.setItem(STORAGE_KEYS[key], serialize(value));
            } catch {
              // Best-effort: an unwritable storage just re-derives on the next read.
            }
          }
          return value;
        }
        return parse(key, raw);
      } catch {
        return defaultFor(key);
      }
    },
    set(key, value) {
      try {
        storage.setItem(STORAGE_KEYS[key], serialize(value));
      } catch {
        // A full/denied storage must not break the control that wrote it.
      }
      broadcast(key, value);
    },
    loadLastCheckAt() {
      try {
        return storage.getItem(LAST_CHECK_AT_KEY);
      } catch {
        return null;
      }
    },
    saveLastCheckAt(iso) {
      try {
        storage.setItem(LAST_CHECK_AT_KEY, iso);
      } catch {
        // Best-effort.
      }
    },
    resetAll() {
      for (const key of SETTING_KEYS) {
        try {
          storage.removeItem(STORAGE_KEYS[key]);
        } catch {
          // Keep resetting the rest.
        }
      }
      try {
        storage.removeItem(LAST_CHECK_AT_KEY);
      } catch {
        // Best-effort.
      }
      for (const key of SETTING_KEYS) {
        broadcast(key, defaultFor(key));
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// trmx-80: hydration — the ONE config_read at boot (main.tsx awaits this before the themed first
// paint), legacy-localStorage migration, theme materialization, and the live bus subscription.
// ---------------------------------------------------------------------------------------------

export interface HydrateSettingsDeps {
  /** The Tauri invoke for config_read now and config_write/config_reset_all later. */
  invoke?: InvokeFn;
  /** The cross-window bus to subscribe on (settings:changed + config:warnings). */
  bus?: SettingsListenBus;
  /** The legacy-key migration source (T3b); defaults to the real localStorage. */
  storage?: KeyValueStore;
}

/** The `config_read` response shape (T2 contract), after defensive parsing. */
interface ConfigReadResult {
  exists: boolean;
  path: string | null;
  values: Record<string, unknown>;
  warnings: unknown[];
}

function parseConfigRead(response: unknown): ConfigReadResult | null {
  if (typeof response !== "object" || response === null) return null;
  const { exists, path, values, warnings } = response as {
    exists?: unknown;
    path?: unknown;
    values?: unknown;
    warnings?: unknown;
  };
  return {
    // Junk `exists` counts as true so a mismatched backend can never trigger a spurious migration.
    exists: exists !== false,
    path: typeof path === "string" ? path : null,
    values:
      typeof values === "object" && values !== null ? (values as Record<string, unknown>) : {},
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}

/**
 * Hydrate the shared snapshot from the backend config file. Awaited FIRST in main.tsx's boot()
 * (before applyStartupTheme — the themed first paint needs the file's values). Never throws: in a
 * plain browser/jsdom the invoke rejects and every read stays on the registry defaults. Seeds the
 * snapshot from `config_read` (each value re-validated), runs the one-time legacy-localStorage
 * migration (T3b), materializes the first-run theme derivation into the file, and subscribes ONCE
 * to `settings:changed` (+ `config:warnings`) so the snapshot stays live for other windows and
 * the backend's config-file watcher.
 */
export async function hydrateSettings(deps: HydrateSettingsDeps = {}): Promise<void> {
  configInvoke = deps.invoke ?? realInvoke;
  const bus = deps.bus ?? realEventBus;
  const storage = deps.storage ?? safeLocalStorage();

  let read: ConfigReadResult | null = null;
  try {
    read = parseConfigRead(await invokeSafely("config_read"));
  } catch {
    // No backend (plain browser/jsdom): defaults, no migration — reads derive via defaultFor.
    read = null;
    // trmx-81 D1: the dev/e2e seam — seed the snapshot from the URL query. ONLY here, on the
    // REJECTION path: a resolved config_read of any shape (even junk) means a backend exists and
    // owns the values, so the packaged app never reaches this line (config_read always resolves
    // there) and the seam is inert outside `pnpm dev`/the Playwright harness.
    seedSnapshotFromQuery();
  }

  if (read) {
    configPath = read.path;
    // A hydration is a full fresh read of the file: it re-bases BOTH ledgers (the seeding loop
    // below re-authors any client warnings the fresh values still deserve).
    fileWarnings = read.warnings.map((w) => ({
      source: "file" as const,
      message: renderConfigWarning(w),
    }));
    clientWarnings.clear();

    // Seed: PRESENT-ONLY values, each re-validated through the registry's per-key semantics. An
    // invalid config-origin value falls back to the default and records a CLIENT warning.
    for (const key of SETTING_KEYS) {
      if (!(key in read.values)) continue;
      const value = coerce(key, read.values[key]);
      if (value === undefined) {
        // trmx-202: a REMOVED built-in theme id (white/paper/mint/sepia) is a recognized legacy
        // value, not junk — seed the derived default SILENTLY (no client warning; the no-write
        // presence rule below applies the same either way).
        if (key === "appearance.theme" && isRemovedBuiltinThemeId(read.values[key])) {
          snapshot.set(key, defaultThemeId());
          continue;
        }
        clientWarnings.set(key, {
          source: "client",
          message: `Invalid value for "${key}" in the config file; using the default.`,
        });
        // trmx-80 review R1: presence ≠ validity. A PRESENT-but-invalid theme must still occupy
        // the snapshot (with the derived default) so the absence-driven materialization below
        // cannot write a derived value over the user's (typo'd) file entry — the file value
        // stays theirs to fix, and every read serves the derived default meanwhile.
        if (key === "appearance.theme") snapshot.set(key, defaultThemeId());
      } else {
        snapshot.set(key, value);
      }
    }

    // T3b migration: only when the config file does not exist yet (a pre-FR-13 install's first
    // launch). File exists → the file wins; legacy keys stay untouched.
    if (!read.exists && storage) {
      await migrateLegacySettings(storage);
    }

    // Theme materialization ("derive once, then persist", trmx-53 — moved here from get()): ONLY
    // when the file carried no theme AT ALL (truly absent — a present-but-invalid one was seeded
    // above without a write) and migration brought none, derive from the OS, seed the snapshot,
    // and write through. A failed write keeps the derived value for this session (it re-derives
    // next launch) and is NOT broadcast — nothing changed for other windows.
    if (!snapshot.has("appearance.theme")) {
      const derived = defaultThemeId();
      snapshot.set("appearance.theme", derived);
      try {
        await invokeSafely("config_write", { key: "appearance.theme", value: derived });
      } catch (err) {
        console.warn("[termixion] theme materialization write failed", err);
      }
    }

    // Hydration replaced/authored warnings above — publish once for any early subscriber.
    publishConfigWarnings();
  }

  subscribeToBus(bus);
}

// trmx-81 D1: the ONLY keys the query seed may touch. A deliberate allowlist — widening it is a
// review decision per key, never a default (the query string is untrusted input and the packaged
// app must stay driven by the config file alone). trmx-82 adds tabs.sideLabelOrientation with the
// same resolved-read-wins semantics. trmx-195 adds appearance.theme so the per-theme visibility
// e2e can boot the main window onto each built-in deterministically (the boot order guarantees
// the seeded value paints: hydrateSettings seeds → applyStartupTheme reads it); the value still
// re-validates through the registry's theme-id coercion, and the seam only ever runs in the
// no-backend fallback the packaged app never hits.
const QUERY_SEEDABLE_KEYS: readonly SettingKey[] = [
  "tabs.barPosition",
  "tabs.sideLabelOrientation",
  "appearance.theme",
];

/**
 * trmx-81 D1: seed the snapshot from `?setting.<key>=<value>` query params — the dev/e2e seam,
 * called ONLY from hydrateSettings' no-backend fallback (config_read REJECTED). Values re-validate
 * through the registry's own coercion (junk → ignored, never a fallback write); every other
 * `setting.*` param is ignored. Snapshot-only: nothing is persisted or broadcast.
 */
function seedSnapshotFromQuery(): void {
  if (typeof window === "undefined") return;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return; // a locked-down location must never break hydration
  }
  for (const key of QUERY_SEEDABLE_KEYS) {
    const raw = params.get(`setting.${key}`);
    if (raw === null) continue;
    const value = coerce(key, raw);
    if (value !== undefined) snapshot.set(key, value);
  }
}

/**
 * T3b: migrate the legacy `termixion.*` localStorage values into the config file. Each value goes
 * through the same per-key parse as always (junk → default, numbers clamped), lands in the
 * snapshot optimistically, and its localStorage key is removed ONLY after its config_write
 * succeeds — a failed write leaves the key for a retry next launch. `update.lastCheckAt` is NOT
 * migrated: it is bookkeeping, not user config, and stays on localStorage forever.
 */
async function migrateLegacySettings(storage: KeyValueStore): Promise<void> {
  for (const key of SETTING_KEYS) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(STORAGE_KEYS[key]);
    } catch {
      continue;
    }
    if (raw === null) continue;
    const value = parse(key, raw);
    snapshot.set(key, value);
    try {
      await invokeSafely("config_write", { key, value });
      storage.removeItem(STORAGE_KEYS[key]);
    } catch (err) {
      console.warn(`[termixion] settings migration write failed for ${key}`, err);
    }
  }
}

/** Subscribe ONCE per module lifetime; hydrateSettings may run again without re-subscribing. */
function subscribeToBus(bus: SettingsListenBus): void {
  if (busSubscribed) return;
  busSubscribed = true;
  try {
    bus
      .listen(SETTINGS_CHANGED_EVENT, applySettingsChangedToSnapshot)
      .then((unlisten) => void busUnlistens.push(unlisten))
      .catch(() => {
        // No Tauri runtime — cross-window/live-config updates simply never arrive.
      });
    bus
      .listen(CONFIG_WARNINGS_EVENT, replaceConfigWarnings)
      .then((unlisten) => void busUnlistens.push(unlisten))
      .catch(() => {
        // Best-effort, as above.
      });
  } catch {
    // A throwing bus must not break hydration.
  }
}

/**
 * Keep the snapshot current for `settings:changed` broadcasts from other windows and from the
 * backend's config-file watcher (source "config-file", a hand-edited file). Payloads are
 * untrusted input: unknown keys and malformed values are inert, and an invalid config-file-origin
 * value additionally records a client warning (the UI surfaces it). The theme is special (trmx-80
 * review R1): the backend cannot validate theme IDs (any string is a valid TOML Str), so an
 * invalid config-file theme applies the DERIVED default to the snapshot — matching what a fresh
 * parse of the file would serve — instead of keeping a stale previous value. Snapshot-only:
 * nothing is ever written back, the broken file value stays the user's to fix.
 */
function applySettingsChangedToSnapshot(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const { key, value, source } = payload as { key?: unknown; value?: unknown; source?: unknown };
  if (typeof key !== "string" || !SETTING_KEYS.includes(key as SettingKey)) return;
  const coerced = coerce(key as SettingKey, value);
  if (coerced === undefined) {
    if (source === "config-file") {
      // trmx-202: a REMOVED built-in id from a live config edit — or the watcher broadcasting the
      // Rust Config::default() "white" after the key is deleted — normalizes SILENTLY: derived
      // default into the snapshot, any prior theme client-warning cleared (the ledger otherwise
      // clears only on the valid path), nothing written back.
      if (key === "appearance.theme" && isRemovedBuiltinThemeId(value)) {
        snapshot.set(key, defaultThemeId());
        if (clientWarnings.delete(key)) publishConfigWarnings();
        return;
      }
      if (key === "appearance.theme") {
        snapshot.set(key, defaultThemeId());
        clientWarnings.set(key, {
          source: "client",
          message: `Invalid value for "${key}" from the config file; using the default theme.`,
        });
      } else {
        clientWarnings.set(key as SettingKey, {
          source: "client",
          message: `Invalid value for "${key}" from the config file; keeping the previous value.`,
        });
      }
      publishConfigWarnings();
    }
    return;
  }
  snapshot.set(key as SettingKey, coerced);
  // A VALID new value for the key supersedes that key's client warning (and only that key's).
  if (clientWarnings.delete(key as SettingKey)) publishConfigWarnings();
}

/** A `config:warnings` broadcast is a fresh parse of the file — it supersedes the FILE ledger
 * wholesale (INCLUDING an empty set, which is how a fixed file clears the UI banner — trmx-80
 * review R2). CLIENT warnings are untouched: the backend cannot see them (e.g. an invalid theme
 * id parses clean as a Str), so only a new value for their key may clear them. */
function replaceConfigWarnings(payload: unknown): void {
  if (!Array.isArray(payload)) return;
  fileWarnings = payload.map((w) => ({
    source: "file" as const,
    message: renderConfigWarning(w),
  }));
  publishConfigWarnings();
}

/** `localStorage` when present (browser/webview), else undefined (SSR / locked-down runtime). */
function safeLocalStorage(): KeyValueStore | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined;
  }
}
