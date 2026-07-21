// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (FR-6, test-first): the theme hot-reload state machine. `decideHotReload` is a pure truth
// table over an injected theme list (built-in active → none; user absent → fallback; user invalid →
// invalidated; user valid → reapply). `installThemeHotReload` is driven with fakes — a captured
// `subscribe`, a fake `hydrate` that (re)populates the real registry, a recording `bus`, and a fake
// settings store — so a `themes:changed` signal proves: a valid edit re-emits settings:changed
// (reapply), a deleted active theme persists the derived default (fallback), an invalidated one warns
// only (no emit/set), and the returned unsubscribe tears the subscription down.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideHotReload,
  installThemeHotReload,
  type HotReloadAction,
} from "./themeHotReload";
import {
  clearUserThemes,
  registerUserThemes,
  type ThemeListEntry,
  type UserThemeEntry,
} from "./registry";
import type { ThemeSpec } from "./themeDerive";
import type { AnsiPalette } from "./tokens";
import { SETTINGS_CHANGED_EVENT, type SettingsStore } from "../settings/settingsStore";
import type { EventBus } from "../ipc/eventBus";

// -------------------------------------------------------------------------------------------------
// decideHotReload — the pure decision (list injected, no registry/settings).
// -------------------------------------------------------------------------------------------------

const builtin: ThemeListEntry = { id: "night", label: "Night", source: "builtin", valid: true, diagnostics: [] };
const userValid: ThemeListEntry = { id: "user:ok", label: "ok", source: "user", valid: true, diagnostics: [] };
const userInvalid: ThemeListEntry = {
  id: "user:bad",
  label: "bad",
  source: "user",
  valid: false,
  diagnostics: [{ severity: "error", message: "the theme file could not be parsed" }],
};

describe("decideHotReload (trmx-89 truth table)", () => {
  it("a BUILT-IN active theme is never affected by a user-theme change → none", () => {
    expect(decideHotReload("night", [builtin, userValid], "night")).toEqual<HotReloadAction>({ kind: "none" });
    // A junk / non-user-shaped id is also `none` (only a user:<stem> id participates).
    expect(decideHotReload("solarized", [], "solarized")).toEqual<HotReloadAction>({ kind: "none" });
    expect(decideHotReload("__proto__", [builtin], "night")).toEqual<HotReloadAction>({ kind: "none" });
  });

  it("an active user theme ABSENT from the fresh list (file deleted) → fallback to the derived default", () => {
    expect(decideHotReload("user:gone", [builtin, userValid], "night")).toEqual<HotReloadAction>({
      kind: "fallback",
      to: "night",
    });
    // The fallback carries whatever derived default it was handed.
    expect(decideHotReload("user:gone", [builtin], "night")).toEqual<HotReloadAction>({
      kind: "fallback",
      to: "night",
    });
  });

  it("an active user theme PRESENT-but-INVALID (edited into a parse error) → invalidated (keep colors)", () => {
    expect(decideHotReload("user:bad", [builtin, userInvalid], "night")).toEqual<HotReloadAction>({
      kind: "invalidated",
      id: "user:bad",
    });
  });

  it("an active user theme PRESENT-and-VALID → reapply its fresh tokens under the same id", () => {
    expect(decideHotReload("user:ok", [builtin, userValid], "night")).toEqual<HotReloadAction>({
      kind: "reapply",
      id: "user:ok",
    });
  });
});

// -------------------------------------------------------------------------------------------------
// installThemeHotReload — driven with fakes over the REAL registry (hydrate repopulates it).
// -------------------------------------------------------------------------------------------------

/** A neutral 16-color palette (mirrors registry.test.ts / themesBackend.test.ts). */
const ANSI: AnsiPalette = {
  black: "#000000", red: "#ff0000", green: "#00ff00", yellow: "#ffff00",
  blue: "#0000ff", magenta: "#ff00ff", cyan: "#00ffff", white: "#ffffff",
  brightBlack: "#808080", brightRed: "#ff8080", brightGreen: "#80ff80", brightYellow: "#ffff80",
  brightBlue: "#8080ff", brightMagenta: "#ff80ff", brightCyan: "#80ffff", brightWhite: "#f0f6fc",
};

/** A valid, high-contrast ThemeSpec (black bg / white text → no contrast warning). */
function validSpec(): ThemeSpec {
  return {
    isDark: true,
    color: { bg: { primary: "#000000" }, text: { primary: "#ffffff" }, accent: {}, semantic: {} },
    terminal: { ansi: { ...ANSI }, scrollbar: {}, pane: {} },
  };
}

function validEntry(id: string): UserThemeEntry {
  return { id, source: "user", valid: true, spec: validSpec(), warnings: [] };
}

function invalidEntry(id: string): UserThemeEntry {
  return { id, source: "user", valid: false, spec: null, warnings: [{ type: "SyntaxError", message: "boom" }] };
}

/** A minimal settings store fake: only appearance.theme is meaningful; `set` is a spy. */
function makeSettings(initialTheme: string) {
  let current = initialTheme;
  const set = vi.fn((key: string, value: unknown) => {
    if (key === "appearance.theme") current = value as string;
  });
  const settings = {
    get: vi.fn((key: string) => (key === "appearance.theme" ? current : undefined)),
    set,
    loadLastCheckAt: () => null,
    saveLastCheckAt: () => {},
    resetAll: () => {},
  } as unknown as SettingsStore;
  return { settings, set };
}

/** A recording bus fake — only `emit` matters for the reapply path. */
function makeBus() {
  const emit = vi.fn();
  const bus = { emit, listen: vi.fn() } as unknown as EventBus;
  return { bus, emit };
}

/** A captured `themes:changed` subscription: `fire()` invokes the installed handler. */
function makeSubscribe() {
  let handler: (() => void) | undefined;
  const teardown = vi.fn();
  const subscribe = vi.fn((h: () => void) => {
    handler = h;
    return teardown;
  }) as unknown as typeof import("./themesBackend").onThemesChanged;
  return { subscribe, teardown, fire: () => handler?.() };
}

/** Drain the microtask chain the async handler runs (one macrotask fully flushes it). */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A window whose OS appearance is light → the derived default is Catppuccin Latte (trmx-202). */
const lightWin = { matchMedia: () => ({ matches: false }) } as unknown as Window;

describe("installThemeHotReload (trmx-89)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearUserThemes();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    clearUserThemes();
  });

  it("subscribes on install and returns the unsubscribe (teardown)", () => {
    const { settings } = makeSettings("night");
    const { subscribe, teardown } = makeSubscribe();
    const { bus } = makeBus();

    const uninstall = installThemeHotReload({
      settings,
      bus,
      subscribe,
      hydrate: vi.fn(async () => {}),
    });
    expect(subscribe).toHaveBeenCalledTimes(1);

    uninstall();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("a still-VALID edit of the active user theme re-emits settings:changed (reapply), never persisting", async () => {
    const { settings, set } = makeSettings("user:mine");
    const { subscribe, fire } = makeSubscribe();
    const { bus, emit } = makeBus();
    // hydrate models the file re-read: the edited-but-still-valid file re-registers under the same id.
    const hydrate = vi.fn(async () => registerUserThemes([validEntry("user:mine")]));

    installThemeHotReload({ settings, bus, subscribe, hydrate, win: lightWin });
    fire();
    await tick();

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledExactlyOnceWith(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "user:mine",
      source: "themes-reload",
    });
    expect(set).not.toHaveBeenCalled(); // a reapply keeps the same id — nothing to persist
  });

  it("a DELETED active user theme falls back to the derived default (settings.set + warn), no reapply", async () => {
    const { settings, set } = makeSettings("user:gone");
    const { subscribe, fire } = makeSubscribe();
    const { bus, emit } = makeBus();
    // hydrate models the deletion: the user set no longer contains user:gone.
    const hydrate = vi.fn(async () => registerUserThemes([]));

    installThemeHotReload({ settings, bus, subscribe, hydrate, win: lightWin });
    fire();
    await tick();

    expect(set).toHaveBeenCalledExactlyOnceWith("appearance.theme", "catppuccin-latte"); // lightWin → Latte (trmx-202)
    expect(emit).not.toHaveBeenCalled(); // fallback goes through settings.set, not a raw re-emit
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("user:gone"); // the deleted theme is named
  });

  it("an INVALIDATED active user theme keeps the previous colors — warn only, no emit and no set", async () => {
    const { settings, set } = makeSettings("user:broken");
    const { subscribe, fire } = makeSubscribe();
    const { bus, emit } = makeBus();
    const hydrate = vi.fn(async () => registerUserThemes([invalidEntry("user:broken")]));

    installThemeHotReload({ settings, bus, subscribe, hydrate, win: lightWin });
    fire();
    await tick();

    expect(emit).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("user:broken"); // the invalid theme is named
  });

  it("a BUILT-IN active theme is inert on a themes:changed signal (none)", async () => {
    const { settings, set } = makeSettings("night");
    const { subscribe, fire } = makeSubscribe();
    const { bus, emit } = makeBus();
    // Even though the user set changed, a built-in active theme is untouched.
    const hydrate = vi.fn(async () => registerUserThemes([validEntry("user:other")]));

    installThemeHotReload({ settings, bus, subscribe, hydrate, win: lightWin });
    fire();
    await tick();

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("swallows a hydrate rejection (warns) without emitting or persisting", async () => {
    const { settings, set } = makeSettings("user:mine");
    const { subscribe, fire } = makeSubscribe();
    const { bus, emit } = makeBus();
    const hydrate = vi.fn(async () => {
      throw new Error("read failed");
    });

    installThemeHotReload({ settings, bus, subscribe, hydrate, win: lightWin });
    fire();
    await tick();

    expect(emit).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce(); // the failure was caught, not thrown
  });
});
