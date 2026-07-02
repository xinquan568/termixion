// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the persisted-settings registry — the one enumerable place every user-visible setting
// lives (storage key, default, parse), generalizing trmx-48's single-key autoCheckStore. Because
// the registry is enumerable, "Reset all settings" restores *everything* by construction, and each
// write/reset broadcasts `settings:changed` over an injected bus so other windows (the live
// terminal in the main window) apply changes immediately. Storage and bus are injected seams —
// unit-testable headless, defensive against absent/throwing backends, exactly like trmx-48.

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

/** The event other windows subscribe to for live application of setting changes. */
export const SETTINGS_CHANGED_EVENT = "settings:changed";

export interface SettingsChanged {
  key: SettingKey;
  value: SettingsValues[SettingKey];
  source: string;
}

export type CheckFrequency = "on-startup" | "daily" | "weekly" | "manual";
export type CursorStyle = "bar" | "block" | "underline";

/** Every user-visible persisted setting and its type. */
export interface SettingsValues {
  "update.autoCheck": boolean;
  "update.checkFrequency": CheckFrequency;
  "update.autoDownload": boolean;
  "terminal.cursorStyle": CursorStyle;
  "terminal.cursorBlink": boolean;
}

export type SettingKey = keyof SettingsValues;

/**
 * trmx-51 defaults: auto-check on, check on startup, auto-download on, underline cursor.
 * trmx-55: cursor blink defaults OFF (iTerm2-default parity — iTerm2 ships a solid, non-blinking
 * cursor; see iterm2Theme.ts). Users who want blinking keep the toggle.
 */
export const SETTING_DEFAULTS: SettingsValues = {
  "update.autoCheck": true,
  "update.checkFrequency": "on-startup",
  "update.autoDownload": true,
  "terminal.cursorStyle": "underline",
  "terminal.cursorBlink": false,
};

// Storage keys: the trmx-48 auto-check key is kept verbatim so existing installs keep their choice.
const STORAGE_KEYS: Record<SettingKey, string> = {
  "update.autoCheck": "termixion.update.autoCheck",
  "update.checkFrequency": "termixion.update.checkFrequency",
  "update.autoDownload": "termixion.update.autoDownload",
  "terminal.cursorStyle": "termixion.terminal.cursorStyle",
  "terminal.cursorBlink": "termixion.terminal.cursorBlink",
};

/** Internal bookkeeping (not a user-visible setting; still cleared by reset). */
const LAST_CHECK_AT_KEY = "termixion.update.lastCheckAt";

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

const FREQUENCIES: readonly CheckFrequency[] = ["on-startup", "daily", "weekly", "manual"];
const CURSOR_STYLES: readonly CursorStyle[] = ["bar", "block", "underline"];

// trmx-55: booleans are default-aware — only the "true"/"false" literals parse; anything else
// falls back to the key's default, matching the enums (and the registry contract: default when
// unset, unparseable, or storage is unavailable). Supersedes trmx-48's permissive `raw !== "false"`.
function parse<K extends SettingKey>(key: K, raw: string): SettingsValues[K] {
  const fallback = SETTING_DEFAULTS[key];
  if (typeof fallback === "boolean") {
    if (raw === "true") return true as SettingsValues[K];
    if (raw === "false") return false as SettingsValues[K];
    return fallback;
  }
  if (key === "update.checkFrequency") {
    return (FREQUENCIES.includes(raw as CheckFrequency)
      ? raw
      : fallback) as SettingsValues[K];
  }
  return (CURSOR_STYLES.includes(raw as CursorStyle) ? raw : fallback) as SettingsValues[K];
}

function serialize(value: SettingsValues[SettingKey]): string {
  return typeof value === "boolean" ? (value ? "true" : "false") : value;
}

export interface SettingsStore {
  /** Read a setting; defaults when unset, unparseable, or storage is unavailable. */
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
 * Build the store over the given backends. `storage` defaults to `localStorage` when present;
 * `bus` is optional (plain dev/jsdom have no cross-window bus); `source` tags broadcasts so
 * subscribers can ignore their own echoes.
 */
export function makeSettingsStore(
  storage: KeyValueStore | undefined = safeLocalStorage(),
  bus?: SettingsBus,
  source: string = "unknown",
): SettingsStore {
  const broadcast = (key: SettingKey, value: SettingsValues[SettingKey]) => {
    if (!bus) return;
    try {
      const result = bus.emit(SETTINGS_CHANGED_EVENT, { key, value, source });
      // A rejected promise (e.g. no Tauri runtime) must not surface as an unhandled rejection.
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // Best-effort: broadcasting must never break the write itself.
    }
  };

  return {
    get(key) {
      if (!storage) return SETTING_DEFAULTS[key];
      try {
        const raw = storage.getItem(STORAGE_KEYS[key]);
        if (raw === null) return SETTING_DEFAULTS[key];
        return parse(key, raw);
      } catch {
        return SETTING_DEFAULTS[key];
      }
    },
    set(key, value) {
      try {
        storage?.setItem(STORAGE_KEYS[key], serialize(value));
      } catch {
        // A full/denied storage must not break the control that wrote it.
      }
      broadcast(key, value);
    },
    loadLastCheckAt() {
      if (!storage) return null;
      try {
        return storage.getItem(LAST_CHECK_AT_KEY);
      } catch {
        return null;
      }
    },
    saveLastCheckAt(iso) {
      try {
        storage?.setItem(LAST_CHECK_AT_KEY, iso);
      } catch {
        // Best-effort.
      }
    },
    resetAll() {
      for (const key of SETTING_KEYS) {
        try {
          storage?.removeItem(STORAGE_KEYS[key]);
        } catch {
          // Keep resetting the rest.
        }
      }
      try {
        storage?.removeItem(LAST_CHECK_AT_KEY);
      } catch {
        // Best-effort.
      }
      for (const key of SETTING_KEYS) {
        broadcast(key, SETTING_DEFAULTS[key]);
      }
    },
  };
}

/** `localStorage` when present (browser/webview), else undefined (SSR / locked-down runtime). */
function safeLocalStorage(): KeyValueStore | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined;
  }
}
