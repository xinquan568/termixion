// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the persisted-settings registry. One enumerable place for every user-visible setting —
// defaults, parsing — so "Reset all settings" can restore *everything* and future keys can't
// silently escape it (R8: these are the failing tests written first).
//
// trmx-80 (FR-13): the VALUE backend is a snapshot hydrated from the backend config file
// (config_read / config_write / config_reset_all) — see the "shared snapshot backend" blocks below.
//
// trmx-253 (T3.4/T3.5): that snapshot is no longer module-level. It lives inside
// `createSettingsRuntime()`, one runtime per boot in production and one per TEST here, which is why
// this file no longer resets anything between cases — a fresh runtime IS the isolation. The second
// backend it used to describe (an explicitly injected `KeyValueStore`, per-instance localStorage,
// test-only since trmx-80 but shipped in production code anyway) is DELETED, and with it every
// assertion that was about localStorage rather than about the settings registry.
//
// This one file constructs `createSettingsRuntime()` directly rather than going through the shared
// `src/test/settingsRuntime` fixture, because the runtime is the unit under test: its real
// construction-time defaults (the un-injected invoke channel especially) are part of what these
// cases pin. Every OTHER suite uses the fixture.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSettingsRuntime,
  isLabelOrientation,
  SETTING_KEYS,
  SETTING_DEFAULTS,
  SETTING_RANGES,
  SETTINGS_CHANGED_EVENT,
  CONFIG_WARNINGS_EVENT,
  type ConfigWarningItem,
  type KeyValueStore,
  type SettingsBus,
  type SettingsListenBus,
  type SettingsRuntime,
} from "./settingsStore";

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function fakeBus(): SettingsBus & { events: Array<{ event: string; payload: unknown }> } {
  const events: Array<{ event: string; payload: unknown }> = [];
  return { events, emit: (event, payload) => void events.push({ event, payload }) };
}

/** A listen-capable bus for hydrateSettings, with a synchronous `fire` for tests. */
function fakeListenBus(): SettingsListenBus & {
  listened: string[];
  fire(event: string, payload: unknown): void;
} {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const listened: string[] = [];
  return {
    listened,
    listen(event, handler) {
      listened.push(event);
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return Promise.resolve(() => void set.delete(handler));
    },
    fire(event, payload) {
      for (const h of [...(handlers.get(event) ?? [])]) h(payload);
    },
  };
}

/** The T2 backend contract, faked: config_read / config_write / config_reset_all. */
function fakeConfigBackend(
  read: Partial<{
    exists: boolean;
    path: string;
    values: Record<string, unknown>;
    warnings: unknown[];
  }> = {},
  opts: { failWrites?: boolean; failRead?: boolean } = {},
) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ cmd, args });
    if (cmd === "config_read") {
      if (opts.failRead) return Promise.reject(new Error("no backend"));
      return Promise.resolve({
        exists: read.exists ?? true,
        path: read.path ?? "/Users/me/Library/Application Support/termixion/config.toml",
        values: read.values ?? {},
        warnings: read.warnings ?? [],
      });
    }
    if (cmd === "config_write") {
      return opts.failWrites ? Promise.reject(new Error("disk full")) : Promise.resolve(null);
    }
    if (cmd === "config_reset_all") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  };
  const writes = () =>
    calls.filter((c) => c.cmd === "config_write").map((c) => c.args as { key: string; value: unknown });
  return { invoke, calls, writes };
}

/** Flush the microtask queue so fire-and-forget rejections have settled. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

// Every test gets its OWN runtime, so it starts from an empty snapshot with no reset call and no
// cross-test leakage. Before trmx-253 this was `__resetSettingsForTest()` over a module global —
// the reset existed only because the state did, and both are gone together.
let runtime: SettingsRuntime;
beforeEach(() => {
  runtime = createSettingsRuntime();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// trmx-253 (T3.5): the "legacy storage-backed mode" blocks that used to sit here are GONE with the
// backend they described — an EXPLICITLY injected KeyValueStore, per-instance localStorage,
// test-only since trmx-80 and shipped in production code anyway. What was worth keeping of them
// lives on, in three different places:
//
//   - REGISTRY semantics (defaults, round-trips, broadcasting, reset) moved onto the runtime's
//     store below. They were never about localStorage; localStorage was only how they were reached.
//   - The per-key `parse()` of a RAW PERSISTED STRING still has exactly one live caller: the T3b
//     legacy-localStorage MIGRATION. Those cases now hydrate through it (`hydrateFromLegacyKeys`),
//     which is both the honest door into `parse` and a better test — it exercises the path a real
//     pre-FR-13 install takes.
//   - Assertions about the storage OBJECT (a raw string landing in the map; a junk write round-
//     tripping through storage and being repaired only at READ time; a throwing KeyValueStore
//     serving defaults from `get`) are DELETED. The surviving backend does none of them: `set()`
//     REJECTS an invalid value outright — it never reaches the snapshot, the file, or the bus — so
//     converting those assertions would have meant asserting the opposite of what the code does.
// ---------------------------------------------------------------------------------------------

/**
 * Seed values the way a PRE-FR-13 install did — raw `termixion.*` localStorage strings — and
 * hydrate onto a config file that does not exist yet, which is the one surviving path through the
 * per-key `parse()`. Returns the migrated snapshot's store plus the backend, so a case can assert
 * either the value served or the config_write it produced.
 */
async function hydrateFromLegacyKeys(entries: Record<string, string>) {
  const backend = fakeConfigBackend({ exists: false, values: {} });
  const storage = fakeStorage(entries);
  await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage });
  return { store: runtime.makeStore(), backend, storage };
}

describe("settingsStore defaults", () => {
  it("serves the registry defaults (trmx-51; blink off since trmx-55) when nothing is persisted", () => {
    const store = runtime.makeStore();
    expect(store.get("update.autoCheck")).toBe(true);
    expect(store.get("update.checkFrequency")).toBe("on-startup");
    expect(store.get("update.autoDownload")).toBe(true);
    expect(store.get("terminal.cursorStyle")).toBe("underline");
    expect(store.get("terminal.cursorBlink")).toBe(false);
    // trmx-80 (FR-13): the scrollback/font trio. trmx-204: the font default is the bundled
    // SauceCodePro face now; "" remains the explicit System-default sentinel.
    expect(store.get("terminal.scrollbackLines")).toBe(10_000);
    expect(store.get("terminal.fontFamily")).toBe("SauceCodePro Nerd Font Mono");
    expect(store.get("terminal.fontSize")).toBe(12);
  });

  it("trmx-206: the shell-enhancement toggles default ON and round-trip", () => {
    const store = runtime.makeStore();
    expect(store.get("shell.enhancements")).toBe(true);
    expect(store.get("shell.autosuggestions")).toBe(true);
    expect(store.get("shell.syntaxHighlighting")).toBe(true);
    store.set("shell.enhancements", false);
    expect(store.get("shell.enhancements")).toBe(false);
  });

  it("trmx-207: shell.prompt is a closed enum — the members round-trip", () => {
    const store = runtime.makeStore();
    expect(store.get("shell.prompt")).toBe("existing");
    store.set("shell.prompt", "starship");
    expect(store.get("shell.prompt")).toBe("starship");
  });

  it("trmx-205: terminal.shell defaults to '' and round-trips a free-form path", () => {
    const store = runtime.makeStore();
    expect(store.get("terminal.shell")).toBe("");
    store.set("terminal.shell", "/opt/homebrew/bin/fish");
    expect(store.get("terminal.shell")).toBe("/opt/homebrew/bin/fish");
  });

  it("round-trips every setting", () => {
    const store = runtime.makeStore();
    store.set("update.autoCheck", false);
    store.set("update.checkFrequency", "weekly");
    store.set("update.autoDownload", false);
    store.set("terminal.cursorStyle", "bar");
    store.set("terminal.cursorBlink", true);
    store.set("terminal.scrollbackLines", 50_000);
    store.set("terminal.fontFamily", "JetBrains Mono");
    store.set("terminal.fontSize", 16);
    expect(store.get("update.autoCheck")).toBe(false);
    expect(store.get("update.checkFrequency")).toBe("weekly");
    expect(store.get("update.autoDownload")).toBe(false);
    expect(store.get("terminal.cursorStyle")).toBe("bar");
    expect(store.get("terminal.cursorBlink")).toBe(true);
    expect(store.get("terminal.scrollbackLines")).toBe(50_000);
    expect(store.get("terminal.fontFamily")).toBe("JetBrains Mono");
    expect(store.get("terminal.fontSize")).toBe(16);
  });
});

// The per-key `parse()` branches, reached through the only caller that survives T3.5. Every case
// below was a "legacy storage mode" test that read a raw string back out of an injected storage;
// the STRINGS and the EXPECTED VALUES are unchanged — only the door into `parse` moved.
describe("the legacy-key migration parses raw persisted strings (the surviving parse() path)", () => {
  it("keeps an explicitly persisted '' fontFamily as '' (System default survives the trmx-204 default flip)", async () => {
    const { store } = await hydrateFromLegacyKeys({ "termixion.terminal.fontFamily": "" });
    expect(store.get("terminal.fontFamily")).toBe("");
  });

  it("treats garbage persisted values as the default", async () => {
    const { store } = await hydrateFromLegacyKeys({
      "termixion.terminal.cursorStyle": "sparkles",
      "termixion.update.checkFrequency": "hourly",
      "termixion.terminal.cursorBlink": "maybe",
      "termixion.update.autoCheck": "maybe",
    });
    expect(store.get("terminal.cursorStyle")).toBe("underline");
    expect(store.get("update.checkFrequency")).toBe("on-startup");
    // trmx-55: boolean reads are default-aware — only the "true"/"false" literals parse; anything
    // else lands on the key's own default ("maybe" → blink off, but auto-check stays on).
    expect(store.get("terminal.cursorBlink")).toBe(false);
    expect(store.get("update.autoCheck")).toBe(true);
  });

  it("trmx-207: a junk persisted shell.prompt re-derives 'existing'", async () => {
    const { store } = await hydrateFromLegacyKeys({ "termixion.shell.prompt": "neon" });
    expect(store.get("shell.prompt")).toBe("existing");
  });

  it("parses and CLAMPS numbers; junk (including the empty string) falls to the default", async () => {
    // trmx-80: the number branch of parse — clamp on read, junk → default (docs/config.md ranges).
    const clamped = await hydrateFromLegacyKeys({
      "termixion.terminal.scrollbackLines": "999999",
      "termixion.terminal.fontSize": "999",
    });
    expect(clamped.store.get("terminal.scrollbackLines")).toBe(200_000);
    expect(clamped.store.get("terminal.fontSize")).toBe(72);

    runtime.dispose();
    const junk = await hydrateFromLegacyKeys({
      "termixion.terminal.scrollbackLines": "lots",
      "termixion.terminal.fontSize": "",
    });
    expect(junk.store.get("terminal.scrollbackLines")).toBe(10_000);
    expect(junk.store.get("terminal.fontSize")).toBe(12);

    runtime.dispose();
    const low = await hydrateFromLegacyKeys({
      "termixion.terminal.scrollbackLines": "-5",
      "termixion.terminal.fontSize": "1",
    });
    expect(low.store.get("terminal.scrollbackLines")).toBe(0);
    expect(low.store.get("terminal.fontSize")).toBe(6);

    // Integers ONLY (the backend contract): a fractional value is invalid → the default.
    runtime.dispose();
    const fractional = await hydrateFromLegacyKeys({
      "termixion.terminal.scrollbackLines": "12.5",
      "termixion.terminal.fontSize": "9.75",
    });
    expect(fractional.store.get("terminal.scrollbackLines")).toBe(10_000);
    expect(fractional.store.get("terminal.fontSize")).toBe(12);
  });

  it("parses only the boolean literals — explicit choices survive in either direction", async () => {
    const { store } = await hydrateFromLegacyKeys({
      "termixion.terminal.cursorBlink": "true",
      "termixion.update.autoDownload": "false",
    });
    expect(store.get("terminal.cursorBlink")).toBe(true);
    expect(store.get("update.autoDownload")).toBe(false);
  });

  it("a throwing storage is skipped key by key — hydration still completes on the defaults", async () => {
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const backend = fakeConfigBackend({ exists: false, values: {} });
    await expect(
      runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: throwing }),
    ).resolves.toBeUndefined();
    expect(runtime.makeStore().get("terminal.cursorStyle")).toBe("underline");
  });
});

describe("settingsStore broadcasting", () => {
  it("broadcasts settings:changed with key, value, and source on set", () => {
    const bus = fakeBus();
    const store = runtime.makeStore(bus, "settings-window");
    store.set("terminal.cursorStyle", "block");
    expect(bus.events).toEqual([
      {
        event: "settings:changed",
        payload: { key: "terminal.cursorStyle", value: "block", source: "settings-window" },
      },
    ]);
  });

  it("does not throw when the bus emit rejects or throws", () => {
    const store = runtime.makeStore({
      emit: () => {
        throw new Error("no tauri");
      },
    });
    expect(() => store.set("terminal.cursorBlink", false)).not.toThrow();
  });
});

describe("resetAllSettings", () => {
  it("returns every registered key to its default, including lastCheckAt", () => {
    const store = runtime.makeStore();
    store.set("terminal.cursorStyle", "bar");
    store.set("update.checkFrequency", "daily");
    store.saveLastCheckAt("2026-07-01T00:00:00Z");
    store.resetAll();
    expect(store.get("terminal.cursorStyle")).toBe("underline");
    expect(store.get("update.checkFrequency")).toBe("on-startup");
    expect(store.loadLastCheckAt()).toBeNull();
  });

  it("broadcasts the DEFAULT value for every user-visible setting — the emitted key set equals the registry", () => {
    const bus = fakeBus();
    const store = runtime.makeStore(bus, "settings-window");
    store.set("terminal.cursorStyle", "bar");
    store.set("terminal.cursorBlink", false);
    bus.events.length = 0;
    store.resetAll();
    const emitted = bus.events.filter((e) => e.event === "settings:changed");
    const emittedKeys = emitted.map((e) => (e.payload as { key: string }).key).sort();
    expect(emittedKeys).toEqual([...SETTING_KEYS].sort());
    for (const e of emitted) {
      const { key, value, source } = e.payload as {
        key: keyof typeof SETTING_DEFAULTS;
        value: unknown;
        source: string;
      };
      // trmx-53: appearance.theme is the one DYNAMIC default — its reset broadcast carries the
      // OS-derived value (jsdom: no matchMedia → night), not the static placeholder.
      expect(value).toEqual(key === "appearance.theme" ? "night" : SETTING_DEFAULTS[key]);
      expect(source).toBe("settings-window");
    }
  });
});

describe("lastCheckAt bookkeeping", () => {
  // The one piece of state the runtime deliberately does NOT own: `update.lastCheckAt` is
  // bookkeeping, not user config, so it stays on the real localStorage forever (docs/config.md)
  // rather than moving into the config file with everything else. That makes it the one value a
  // per-test runtime cannot isolate — hence the explicit clear.
  beforeEach(() => {
    localStorage.removeItem("termixion.update.lastCheckAt");
  });

  it("round-trips and defaults to null", () => {
    const store = runtime.makeStore();
    expect(store.loadLastCheckAt()).toBeNull();
    store.saveLastCheckAt("2026-07-02T01:02:03Z");
    expect(store.loadLastCheckAt()).toBe("2026-07-02T01:02:03Z");
    expect(localStorage.getItem("termixion.update.lastCheckAt")).toBe("2026-07-02T01:02:03Z");
  });
});

describe("registry shape", () => {
  it("exposes the enumerable user-visible key set (trmx-51 + theme trmx-53 + FR-13 trio trmx-80 + tab bar trmx-81/82 + activity trmx-91 + AI counter trmx-190)", () => {
    expect([...SETTING_KEYS].sort()).toEqual(
      [
        "update.autoCheck",
        "update.checkFrequency",
        "update.autoDownload",
        "terminal.cursorStyle",
        "terminal.cursorBlink",
        "terminal.activityIndicator",
        "terminal.confirmClose",
        "terminal.clipboardWrite",
        "terminal.copyOnSelect",
        "terminal.focusFollowsMouse",
        "terminal.scrollbackLines",
        "terminal.fontFamily",
        "terminal.fontSize",
        "terminal.shell",
        "shell.enhancements",
        "shell.autosuggestions",
        "shell.syntaxHighlighting",
        "shell.prompt",
        "appearance.theme",
        "tabs.barPosition",
        "tabs.sideLabelOrientation",
        "tabs.showShortcutHints",
        "titleBar.aiCounter",
        "scripts.startup",
        "remote_control.enabled",
        "remote_control.socketPath",
      ].sort(),
    );
  });

  it("exposes the numeric ranges (mirrors termixion-core's ranges, see docs/config.md)", () => {
    expect(SETTING_RANGES["terminal.scrollbackLines"]).toEqual({ min: 0, max: 200_000 });
    expect(SETTING_RANGES["terminal.fontSize"]).toEqual({ min: 6, max: 72 });
  });

  it("never uses vi timers or real Tauri — pure seams only", () => {
    // (documentation-by-test: makeSettingsStore takes only injected seams)
    expect(vi.isFakeTimers()).toBe(false);
  });
});

// trmx-93 (FR-5): scripts.startup — a free-string key exactly like terminal.fontFamily: default "",
// any string is a valid value (a scripts-root relative path), validated at launch not here. This
// guards the review finding-2 regression: a persisted script path must round-trip verbatim through
// STORAGE_KEYS + parse() + coerce(), never coerced to a default like an enum key would be.
describe("scripts.startup (trmx-93)", () => {
  it("defaults to \"\"", () => {
    expect(runtime.makeStore().get("scripts.startup")).toBe("");
  });

  it("round-trips an arbitrary path verbatim", () => {
    const store = runtime.makeStore();
    store.set("scripts.startup", "work/proj-x.sh");
    expect(store.get("scripts.startup")).toBe("work/proj-x.sh");
    store.set("scripts.startup", "");
    expect(store.get("scripts.startup")).toBe("");
  });

  it("migrates a persisted path unchanged (not coerced to a default)", async () => {
    // The review finding-2 regression guard, on the surviving parse() caller: a free-string key
    // must survive STORAGE_KEYS + parse() verbatim, spaces and all, never coerced like an enum.
    const { store } = await hydrateFromLegacyKeys({
      "termixion.scripts.startup": "demo/my proj.sh",
    });
    expect(store.get("scripts.startup")).toBe("demo/my proj.sh");
  });

  it("snapshot mode: set writes through config_write and broadcasts", async () => {
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = runtime.makeStore(bus, "settings");
    store.set("scripts.startup", "work/proj-x.sh");
    expect(store.get("scripts.startup")).toBe("work/proj-x.sh");
    expect(backend.writes()).toContainEqual({ key: "scripts.startup", value: "work/proj-x.sh" });
    expect(bus.events).toEqual([
      {
        event: SETTINGS_CHANGED_EVENT,
        payload: { key: "scripts.startup", value: "work/proj-x.sh", source: "settings" },
      },
    ]);
  });
});

// trmx-81 (FR-2.2): tabs.barPosition — the tab bar's window edge. A plain enum key exactly like
// terminal.cursorStyle: default "bottom", only the four members parse, junk falls to the default.
describe("tabs.barPosition (trmx-81)", () => {
  it("defaults to \"bottom\"", () => {
    expect(runtime.makeStore().get("tabs.barPosition")).toBe("bottom");
  });

  it("round-trips all four positions", () => {
    const store = runtime.makeStore();
    for (const position of ["top", "bottom", "left", "right"] as const) {
      store.set("tabs.barPosition", position);
      expect(store.get("tabs.barPosition")).toBe(position);
    }
  });

  it("treats a junk persisted value as the default (enum parse-with-fallback)", async () => {
    // The raw-string parse now runs only on the legacy-key migration path (T3.5 deleted the
    // storage backend that used to re-parse on every read); the value and the fallback are
    // unchanged.
    const { store } = await hydrateFromLegacyKeys({ "termixion.tabs.barPosition": "middle" });
    expect(store.get("tabs.barPosition")).toBe("bottom");
  });

  it("snapshot mode: set validates, writes through config_write, and broadcasts; junk is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = runtime.makeStore(bus, "settings");
    store.set("tabs.barPosition", "left");
    expect(store.get("tabs.barPosition")).toBe("left");
    expect(backend.writes()).toContainEqual({ key: "tabs.barPosition", value: "left" });
    expect(bus.events).toEqual([
      {
        event: SETTINGS_CHANGED_EVENT,
        payload: { key: "tabs.barPosition", value: "left", source: "settings" },
      },
    ]);
    // Junk (a bad cast at runtime) is dropped whole: no snapshot change, no write, no broadcast.
    bus.events.length = 0;
    const writesBefore = backend.writes().length;
    store.set("tabs.barPosition", "middle" as never);
    expect(store.get("tabs.barPosition")).toBe("left");
    expect(backend.writes().length).toBe(writesBefore);
    expect(bus.events).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps a shape-valid user: theme id even before the registry scan resolves (trmx-89 C1)", async () => {
    // themes_read() populates the theme registry only AFTER boot, so a persisted `user:<stem>` id
    // must SURVIVE the pre-scan set/coerce (isUserThemeIdShape) rather than being dropped back to a
    // built-in default. resolveTheme serves the derived default for it until the scan resolves (trmx-202).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const store = runtime.makeStore(fakeBus(), "settings");

    store.set("appearance.theme", "user:solarizedish");
    expect(store.get("appearance.theme")).toBe("user:solarizedish");
    expect(backend.writes()).toContainEqual({
      key: "appearance.theme",
      value: "user:solarizedish",
    });

    // A non-user-shaped, non-built-in value is STILL rejected (unchanged from before C1).
    store.set("appearance.theme", "neon");
    expect(store.get("appearance.theme")).toBe("user:solarizedish");
    expect(warn).toHaveBeenCalled();
  });

  it("hydration seeds a valid file value; an invalid one falls to the default + client warning", async () => {
    const backend = fakeConfigBackend({
      values: { "tabs.barPosition": "top", "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.barPosition")).toBe("top");

    runtime.dispose(); // was __resetSettingsForTest(): the same call, on this test's own runtime
    const junk = fakeConfigBackend({
      values: { "tabs.barPosition": "diagonal", "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: junk.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.barPosition")).toBe("bottom");
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("tabs.barPosition"),
      ),
    ).toBe(true);
  });

  it("live settings:changed applies a valid value; junk is inert (config-file junk warns)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = runtime.makeStore();
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "tabs.barPosition", value: "right", source: "config-file" });
    expect(store.get("tabs.barPosition")).toBe("right");
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "tabs.barPosition", value: "middle", source: "config-file" });
    expect(store.get("tabs.barPosition")).toBe("right"); // the junk value never landed
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("tabs.barPosition"),
      ),
    ).toBe(true);
  });
});

// trmx-82 (FR-2.3): tabs.sideLabelOrientation — how the side-rail tab labels run. A plain enum
// key exactly like tabs.barPosition: default "horizontal", only the two members parse, junk falls
// to the default. Only meaningful while the bar sits on a side edge (App gates via
// labelOrientationFor) — the registry itself stores it unconditionally.
describe("tabs.sideLabelOrientation (trmx-82)", () => {
  it('defaults to "horizontal" in both backends', () => {
    expect(runtime.makeStore().get("tabs.sideLabelOrientation")).toBe("horizontal");
  });

  it("round-trips both orientations", () => {
    const store = runtime.makeStore();
    for (const orientation of ["vertical", "horizontal"] as const) {
      store.set("tabs.sideLabelOrientation", orientation);
      expect(store.get("tabs.sideLabelOrientation")).toBe(orientation);
    }
  });

  it("treats a junk persisted value as the default (enum parse-with-fallback)", async () => {
    // The raw-string parse now runs only on the legacy-key migration path (T3.5 deleted the
    // storage backend that used to re-parse on every read); the value and the fallback are
    // unchanged.
    const { store } = await hydrateFromLegacyKeys({ "termixion.tabs.sideLabelOrientation": "diagonal" });
    expect(store.get("tabs.sideLabelOrientation")).toBe("horizontal");
  });

  it("isLabelOrientation guards exactly the two members (App's payload guard uses it)", () => {
    expect(isLabelOrientation("horizontal")).toBe(true);
    expect(isLabelOrientation("vertical")).toBe(true);
    expect(isLabelOrientation("diagonal")).toBe(false);
    expect(isLabelOrientation("")).toBe(false);
    expect(isLabelOrientation(7)).toBe(false);
    expect(isLabelOrientation(null)).toBe(false);
    expect(isLabelOrientation(undefined)).toBe(false);
  });

  it("snapshot mode: set validates, writes through config_write, and broadcasts; junk is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = runtime.makeStore(bus, "settings");
    store.set("tabs.sideLabelOrientation", "vertical");
    expect(store.get("tabs.sideLabelOrientation")).toBe("vertical");
    expect(backend.writes()).toContainEqual({ key: "tabs.sideLabelOrientation", value: "vertical" });
    expect(bus.events).toEqual([
      {
        event: SETTINGS_CHANGED_EVENT,
        payload: { key: "tabs.sideLabelOrientation", value: "vertical", source: "settings" },
      },
    ]);
    // Junk (a bad cast at runtime) is dropped whole: no snapshot change, no write, no broadcast.
    bus.events.length = 0;
    const writesBefore = backend.writes().length;
    store.set("tabs.sideLabelOrientation", "diagonal" as never);
    expect(store.get("tabs.sideLabelOrientation")).toBe("vertical");
    expect(backend.writes().length).toBe(writesBefore);
    expect(bus.events).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("hydration seeds a valid file value; an invalid one falls to the default + client warning", async () => {
    const backend = fakeConfigBackend({
      values: { "tabs.sideLabelOrientation": "vertical", "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.sideLabelOrientation")).toBe("vertical");

    runtime.dispose(); // was __resetSettingsForTest(): the same call, on this test's own runtime
    const junk = fakeConfigBackend({
      values: { "tabs.sideLabelOrientation": "diagonal", "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: junk.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.sideLabelOrientation")).toBe("horizontal");
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("tabs.sideLabelOrientation"),
      ),
    ).toBe(true);
  });

  it("live settings:changed applies a valid value; junk is inert (config-file junk warns)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = runtime.makeStore();
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "tabs.sideLabelOrientation",
      value: "vertical",
      source: "config-file",
    });
    expect(store.get("tabs.sideLabelOrientation")).toBe("vertical");
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "tabs.sideLabelOrientation",
      value: "diagonal",
      source: "config-file",
    });
    expect(store.get("tabs.sideLabelOrientation")).toBe("vertical"); // the junk value never landed
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("tabs.sideLabelOrientation"),
      ),
    ).toBe(true);
  });
});

// trmx-151: tabs.showShortcutHints — the ⌘1–⌘9 tab-strip number hints on/off. A plain boolean key
// exactly like terminal.activityIndicator: default true, only the "true"/"false" literals parse
// (legacy) / only real booleans coerce (snapshot), junk falls to the default. The strip gates the
// RENDER only — the effective keymap itself is untouched by this setting.
describe("tabs.showShortcutHints (trmx-151)", () => {
  it("defaults to true", () => {
    expect(runtime.makeStore().get("tabs.showShortcutHints")).toBe(true);
  });

  it("round-trips a toggle", () => {
    const store = runtime.makeStore();
    store.set("tabs.showShortcutHints", false);
    expect(store.get("tabs.showShortcutHints")).toBe(false);
    store.set("tabs.showShortcutHints", true);
    expect(store.get("tabs.showShortcutHints")).toBe(true);
  });

  it("treats a junk persisted value as the default (boolean parse-with-fallback)", async () => {
    // The raw-string parse now runs only on the legacy-key migration path (T3.5 deleted the
    // storage backend that used to re-parse on every read); the value and the fallback are
    // unchanged.
    const { store } = await hydrateFromLegacyKeys({ "termixion.tabs.showShortcutHints": "maybe" });
    expect(store.get("tabs.showShortcutHints")).toBe(true);
  });

  it("snapshot mode: set validates, writes through config_write, and broadcasts; junk is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = runtime.makeStore(bus, "settings");
    store.set("tabs.showShortcutHints", false);
    expect(store.get("tabs.showShortcutHints")).toBe(false);
    expect(backend.writes()).toContainEqual({ key: "tabs.showShortcutHints", value: false });
    expect(bus.events).toEqual([
      {
        event: SETTINGS_CHANGED_EVENT,
        payload: { key: "tabs.showShortcutHints", value: false, source: "settings" },
      },
    ]);
    // Junk (a bad cast at runtime) is dropped whole: no snapshot change, no write, no broadcast.
    bus.events.length = 0;
    const writesBefore = backend.writes().length;
    store.set("tabs.showShortcutHints", "yes" as never);
    expect(store.get("tabs.showShortcutHints")).toBe(false);
    expect(backend.writes().length).toBe(writesBefore);
    expect(bus.events).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("hydration seeds a valid file value; an invalid one falls to the default + client warning", async () => {
    const backend = fakeConfigBackend({
      values: { "tabs.showShortcutHints": false, "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.showShortcutHints")).toBe(false);

    runtime.dispose(); // was __resetSettingsForTest(): the same call, on this test's own runtime
    const junk = fakeConfigBackend({
      values: { "tabs.showShortcutHints": "yes", "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: junk.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.showShortcutHints")).toBe(true);
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("tabs.showShortcutHints"),
      ),
    ).toBe(true);
  });
});

// trmx-144: terminal.confirmClose — the close-confirmation tri-state (pane/tab close + quit). A
// plain enum key exactly like terminal.cursorStyle: default "when-busy", only the three members
// ("never" | "when-busy" | "always") parse/coerce, junk falls to the default.
describe("terminal.confirmClose (trmx-144)", () => {
  it('defaults to "when-busy" in both backends', () => {
    expect(runtime.makeStore().get("terminal.confirmClose")).toBe("when-busy");
  });

  it("round-trips all three values", () => {
    const store = runtime.makeStore();
    for (const value of ["never", "when-busy", "always"] as const) {
      store.set("terminal.confirmClose", value);
      expect(store.get("terminal.confirmClose")).toBe(value);
    }
  });

  it("treats a junk persisted value as the default (enum parse-with-fallback)", async () => {
    // The raw-string parse now runs only on the legacy-key migration path (T3.5 deleted the
    // storage backend that used to re-parse on every read); the value and the fallback are
    // unchanged.
    const { store } = await hydrateFromLegacyKeys({ "termixion.terminal.confirmClose": "sometimes" });
    expect(store.get("terminal.confirmClose")).toBe("when-busy");
  });

  it("snapshot mode: set validates, writes through config_write, and broadcasts; junk is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = runtime.makeStore(bus, "settings");
    store.set("terminal.confirmClose", "always");
    expect(store.get("terminal.confirmClose")).toBe("always");
    expect(backend.writes()).toContainEqual({ key: "terminal.confirmClose", value: "always" });
    expect(bus.events).toEqual([
      {
        event: SETTINGS_CHANGED_EVENT,
        payload: { key: "terminal.confirmClose", value: "always", source: "settings" },
      },
    ]);
    // Junk (a bad cast at runtime) is dropped whole: no snapshot change, no write, no broadcast.
    bus.events.length = 0;
    const writesBefore = backend.writes().length;
    store.set("terminal.confirmClose", "sometimes" as never);
    expect(store.get("terminal.confirmClose")).toBe("always");
    expect(backend.writes().length).toBe(writesBefore);
    expect(bus.events).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("hydration seeds a valid file value; an invalid one falls to the default + client warning", async () => {
    const backend = fakeConfigBackend({
      values: { "terminal.confirmClose": "never", "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("terminal.confirmClose")).toBe("never");

    runtime.dispose(); // was __resetSettingsForTest(): the same call, on this test's own runtime
    const junk = fakeConfigBackend({
      values: { "terminal.confirmClose": "sometimes", "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: junk.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("terminal.confirmClose")).toBe("when-busy");
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("terminal.confirmClose"),
      ),
    ).toBe(true);

    // Wrong TYPE entirely (a number) is rejected by coerce the same way.
    runtime.dispose(); // was __resetSettingsForTest(): the same call, on this test's own runtime
    const wrongType = fakeConfigBackend({
      values: { "terminal.confirmClose": 7, "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: wrongType.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("terminal.confirmClose")).toBe("when-busy");
  });

  it("live settings:changed applies a valid value; junk is inert (config-file junk warns)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = runtime.makeStore();
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "terminal.confirmClose",
      value: "always",
      source: "config-file",
    });
    expect(store.get("terminal.confirmClose")).toBe("always");
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "terminal.confirmClose",
      value: "sometimes",
      source: "config-file",
    });
    expect(store.get("terminal.confirmClose")).toBe("always"); // the junk value never landed
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("terminal.confirmClose"),
      ),
    ).toBe(true);
  });
});

// trmx-252 (test 10): terminal.clipboardWrite — the OSC 52 clipboard-write policy ("allow" |
// "deny"), default "allow" (current behaviour; opt-in hardening). The whole FRONTEND fan-out is
// pinned here because a partial addition fails silently: a key missing from SETTING_DEFAULTS is
// not enumerable (so Reset all skips it), one missing from `coerce` never hydrates and never
// applies a live config-file edit, and one missing from `parse` reads back junk in legacy mode.
describe("terminal.clipboardWrite (trmx-252)", () => {
  it('defaults to "allow" — upgrading must not change behaviour', () => {
    expect(runtime.makeStore().get("terminal.clipboardWrite")).toBe("allow");
    expect(SETTING_DEFAULTS["terminal.clipboardWrite"]).toBe("allow");
  });

  it("round-trips both values", () => {
    const store = runtime.makeStore();
    for (const value of ["allow", "deny"] as const) {
      store.set("terminal.clipboardWrite", value);
      expect(store.get("terminal.clipboardWrite")).toBe(value);
    }
  });

  it("treats a junk persisted value as the default (enum parse-with-fallback)", async () => {
    // The raw-string parse now runs only on the legacy-key migration path (T3.5 deleted the
    // storage backend that used to re-parse on every read); the value and the fallback are
    // unchanged.
    const { store } = await hydrateFromLegacyKeys({ "termixion.terminal.clipboardWrite": "maybe" });
    expect(store.get("terminal.clipboardWrite")).toBe("allow");
  });

  it("snapshot mode: set validates, writes through config_write, and broadcasts; junk is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = runtime.makeStore(bus, "settings");
    store.set("terminal.clipboardWrite", "deny");
    expect(store.get("terminal.clipboardWrite")).toBe("deny");
    expect(backend.writes()).toContainEqual({ key: "terminal.clipboardWrite", value: "deny" });
    expect(bus.events).toEqual([
      {
        event: SETTINGS_CHANGED_EVENT,
        payload: { key: "terminal.clipboardWrite", value: "deny", source: "settings" },
      },
    ]);
    bus.events.length = 0;
    const writesBefore = backend.writes().length;
    store.set("terminal.clipboardWrite", "maybe" as never);
    expect(store.get("terminal.clipboardWrite")).toBe("deny");
    expect(backend.writes().length).toBe(writesBefore);
    expect(bus.events).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("hydration seeds a valid file value; an invalid one falls to the default + client warning", async () => {
    const backend = fakeConfigBackend({
      values: { "terminal.clipboardWrite": "deny", "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("terminal.clipboardWrite")).toBe("deny");

    runtime.dispose(); // was __resetSettingsForTest(): the same call, on this test's own runtime
    const junk = fakeConfigBackend({
      values: { "terminal.clipboardWrite": "maybe", "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: junk.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("terminal.clipboardWrite")).toBe("allow");
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("terminal.clipboardWrite"),
      ),
    ).toBe(true);

    // Wrong TYPE entirely (a boolean) is rejected by coerce the same way.
    runtime.dispose(); // was __resetSettingsForTest(): the same call, on this test's own runtime
    const wrongType = fakeConfigBackend({
      values: { "terminal.clipboardWrite": true, "appearance.theme": "night" },
    });
    await runtime.hydrate({
      invoke: wrongType.invoke,
      bus: fakeListenBus(),
      storage: fakeStorage(),
    });
    expect(runtime.makeStore().get("terminal.clipboardWrite")).toBe("allow");
  });

  it("live settings:changed applies a valid value; junk is inert (config-file junk warns)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = runtime.makeStore();
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "terminal.clipboardWrite",
      value: "deny",
      source: "config-file",
    });
    expect(store.get("terminal.clipboardWrite")).toBe("deny");
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "terminal.clipboardWrite",
      value: "maybe",
      source: "config-file",
    });
    expect(store.get("terminal.clipboardWrite")).toBe("deny"); // the junk value never landed
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("terminal.clipboardWrite"),
      ),
    ).toBe(true);
  });
});

// trmx-81 D1 (widened by trmx-82): the dev/e2e query seed. ONLY when config_read REJECTS (no Tauri
// runtime at all — `pnpm dev`, the Playwright e2e harness) may `?setting.<key>=<v>` seed the
// snapshot; a RESOLVED read of ANY shape means a backend is present and the query is ignored
// entirely. The allowlist is deliberate and reviewed per key (trmx-81: tabs.barPosition; trmx-82
// adds tabs.sideLabelOrientation), and values re-validate through the registry (junk → ignored).
describe("D1 e2e query seed (trmx-81)", () => {
  function setSearch(search: string) {
    window.history.replaceState({}, "", `${window.location.pathname}${search}`);
  }
  afterEach(() => {
    setSearch("");
  });

  it("REJECTED config_read (no backend): the allowlisted query seeds the snapshot", async () => {
    setSearch("?setting.tabs.barPosition=top");
    const backend = fakeConfigBackend({}, { failRead: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.barPosition")).toBe("top");
    expect(backend.writes()).toEqual([]); // snapshot-only: the seed never writes a config file
  });

  it("RESOLVED config_read: the query is ignored entirely (a backend is present)", async () => {
    setSearch("?setting.tabs.barPosition=top");
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.barPosition")).toBe("bottom");
  });

  it("RESOLVED-but-junk config_read still means a backend is present: query ignored", async () => {
    setSearch("?setting.tabs.barPosition=top");
    // A junk-shaped response (not even an object) still RESOLVED — the runtime exists.
    const invoke = (cmd: string) =>
      cmd === "config_read" ? Promise.resolve("garbage") : Promise.resolve(null);
    await runtime.hydrate({ invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.barPosition")).toBe("bottom");

    // Same for a resolved read whose VALUES carry junk: backend present, query ignored.
    runtime.dispose(); // was __resetSettingsForTest(): the same call, on this test's own runtime
    setSearch("?setting.tabs.barPosition=top");
    const junkValues = fakeConfigBackend({
      values: { "tabs.barPosition": "diagonal", "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: junkValues.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.barPosition")).toBe("bottom");
  });

  it("a junk query value re-validates through the registry and is ignored", async () => {
    setSearch("?setting.tabs.barPosition=middle");
    const backend = fakeConfigBackend({}, { failRead: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.barPosition")).toBe("bottom");
  });

  it("a disallowed setting.* key never seeds (a deliberate per-key allowlist)", async () => {
    // fontFamily is NOT on the allowlist, and its STRING value would pass coercion if the key
    // leaked in — so this is a real leak detector (a number key like fontSize would be masked:
    // coerce rejects query strings for number keys regardless of the allowlist).
    setSearch("?setting.terminal.fontFamily=Menlo");
    const backend = fakeConfigBackend({}, { failRead: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    // trmx-204: the registry default (bundled SauceCodePro), NOT the leaked query value.
    expect(runtime.makeStore().get("terminal.fontFamily")).toBe("SauceCodePro Nerd Font Mono");
  });

  // trmx-195: appearance.theme JOINS the allowlist — the per-theme visibility e2e must boot the
  // main window onto each built-in deterministically (the boot order guarantees the seeded value
  // paints: hydrateSettings seeds → applyStartupTheme reads it). Same seam contract as the other
  // keys: registry-coerced (junk ignored, never a fallback write), snapshot-only, no-backend only.
  it("trmx-195: REJECTED config_read seeds appearance.theme from the query", async () => {
    // `sepia` (not the jsdom-derived default `night`) so the seed is OBSERVABLE.
    setSearch("?setting.appearance.theme=solarized");
    const backend = fakeConfigBackend({}, { failRead: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("appearance.theme")).toBe("solarized");
  });

  it("trmx-195: a junk theme id in the query is ignored (registry coercion, not a fallback write)", async () => {
    setSearch("?setting.appearance.theme=hotdog-stand");
    const backend = fakeConfigBackend({}, { failRead: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("appearance.theme")).toBe("night"); // the derived default
  });

  // trmx-82: the seam guards, duplicated for the widened allowlist key — the SAME
  // resolved-read-wins semantics as tabs.barPosition.
  it("trmx-82: REJECTED config_read seeds tabs.sideLabelOrientation from the query", async () => {
    setSearch("?setting.tabs.sideLabelOrientation=vertical");
    const backend = fakeConfigBackend({}, { failRead: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.sideLabelOrientation")).toBe("vertical");
    expect(backend.writes()).toEqual([]); // snapshot-only: the seed never writes a config file
  });

  it("trmx-82: a RESOLVED config_read ignores the tabs.sideLabelOrientation query entirely", async () => {
    setSearch("?setting.tabs.sideLabelOrientation=vertical");
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.sideLabelOrientation")).toBe("horizontal");
  });

  it("trmx-82: a junk tabs.sideLabelOrientation query value re-validates and is ignored", async () => {
    setSearch("?setting.tabs.sideLabelOrientation=diagonal");
    const backend = fakeConfigBackend({}, { failRead: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.sideLabelOrientation")).toBe("horizontal");
  });

  it("trmx-82: both allowlisted keys seed together on the rejection path", async () => {
    setSearch("?setting.tabs.barPosition=left&setting.tabs.sideLabelOrientation=vertical");
    const backend = fakeConfigBackend({}, { failRead: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("tabs.barPosition")).toBe("left");
    expect(runtime.makeStore().get("tabs.sideLabelOrientation")).toBe("vertical");
  });
});

// trmx-53: appearance.theme's derived first-run default and its junk fallback.
//
// trmx-253 (T3.5) DELETED the third case that used to open this block — "derives the first-run
// default and MATERIALIZES it" asserted that a `get()` wrote the derived id back into the injected
// storage. That was the deleted backend's read-time materialization; the surviving backend
// materializes at HYDRATION and a read never writes, which is pinned by "theme materialization at
// hydration" further down. Keeping the old assertion would have contradicted the live code.
describe("appearance.theme (trmx-53)", () => {
  const THEME_STORAGE_KEY = "termixion.appearance.theme";

  it("round-trips an explicit choice", () => {
    const store = runtime.makeStore();
    store.set("appearance.theme", "solarized");
    expect(store.get("appearance.theme")).toBe("solarized");
  });

  it("treats a junk persisted id as the derived default", async () => {
    const { store } = await hydrateFromLegacyKeys({ [THEME_STORAGE_KEY]: "hotdog-stand" });
    expect(store.get("appearance.theme")).toBe("night");
  });
});

// ---------------------------------------------------------------------------------------------
// trmx-80 (FR-13): the SHARED SNAPSHOT backend — every storage-less runtime.makeStore() reads and
// writes one module-level snapshot, hydrated once from the backend config file.
// ---------------------------------------------------------------------------------------------

describe("shared snapshot backend (trmx-80)", () => {
  it("construction before hydration is safe: reads serve defaults, incl. the derived theme", () => {
    const store = runtime.makeStore(fakeBus(), "main");
    expect(store.get("update.autoCheck")).toBe(true);
    expect(store.get("terminal.scrollbackLines")).toBe(10_000);
    expect(store.get("terminal.fontFamily")).toBe("SauceCodePro Nerd Font Mono"); // trmx-204
    expect(store.get("terminal.fontSize")).toBe(12);
    // The OS-derived theme (jsdom: no matchMedia → night) still derives through defaultFor.
    expect(store.get("appearance.theme")).toBe("night");
  });

  it("all storage-less instances share the one snapshot", async () => {
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const a = runtime.makeStore(fakeBus(), "settings");
    const b = runtime.makeStore();
    a.set("terminal.fontSize", 20);
    expect(b.get("terminal.fontSize")).toBe(20);
  });

  it("set validates/clamps, updates the snapshot optimistically, writes through config_write, and broadcasts", async () => {
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = runtime.makeStore(bus, "settings");
    store.set("terminal.scrollbackLines", 999_999); // above the max → clamped
    expect(store.get("terminal.scrollbackLines")).toBe(200_000);
    expect(backend.writes()).toContainEqual({ key: "terminal.scrollbackLines", value: 200_000 });
    expect(bus.events).toEqual([
      {
        event: SETTINGS_CHANGED_EVENT,
        payload: { key: "terminal.scrollbackLines", value: 200_000, source: "settings" },
      },
    ]);
  });

  it("set REJECTS a non-integer for a number key: no snapshot change, no write, no broadcast", async () => {
    // trmx-80 review R4 — STRICT REJECTION, matching the backend: config_write refuses fractional
    // numbers, so committing one optimistically would diverge the UI/session from the file.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = runtime.makeStore(bus, "settings");
    store.set("terminal.fontSize", 14);
    bus.events.length = 0;
    const writesBefore = backend.writes().length;
    store.set("terminal.fontSize", 12.5);
    expect(store.get("terminal.fontSize")).toBe(14); // the fractional value never landed
    expect(backend.writes().length).toBe(writesBefore); // …never reached config_write
    expect(bus.events).toEqual([]); // …and never broadcast
    expect(warn).toHaveBeenCalled(); // the rejection is observable in the console
  });

  it("a failing config_write never throws — the optimistic snapshot value stands (warned)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } }, { failWrites: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const store = runtime.makeStore(fakeBus(), "settings");
    expect(() => store.set("terminal.fontSize", 18)).not.toThrow();
    expect(store.get("terminal.fontSize")).toBe(18);
    // The rejection is swallowed asynchronously; flush the microtask queue before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
  });

  // trmx-238 (M14): a rejected config_write used to be console.warn-only, so the toggle showed the
  // new value over a file that never changed — with a syntax-broken config (config_io refuses to
  // rewrite unparseable TOML) EVERY settings change silently reverted on the next launch.
  describe("trmx-238 (M14): a rejected config_write is surfaced as a client warning", () => {
    it("set(): authors a warning keyed by the setting, and a later successful write clears it", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let fail = true;
      const invoke = (cmd: string): Promise<unknown> => {
        if (cmd === "config_read")
          return Promise.resolve({ exists: true, path: "/c.toml", values: {}, warnings: [] });
        if (cmd === "config_write")
          return fail ? Promise.reject(new Error("disk full")) : Promise.resolve(null);
        return Promise.reject(new Error(`unexpected ${cmd}`));
      };
      await runtime.hydrate({ invoke, bus: fakeListenBus(), storage: fakeStorage() });
      const store = runtime.makeStore(fakeBus(), "settings");

      store.set("terminal.fontSize", 18);
      await flushMicrotasks();
      // Scoped to the key under test: hydration's own first-run theme materialization write also
      // rejects against this backend, and authoring THAT warning is correct (M14 covers it too).
      const forKey = () =>
        runtime.getConfigWarnings().filter((w) => w.message.includes("terminal.fontSize"));
      expect(forKey()).toHaveLength(1);
      expect(forKey()[0].source).toBe("client");
      expect(forKey()[0].message).toContain("disk full");

      // The file became writable again: the next successful write clears that key's complaint.
      fail = false;
      store.set("terminal.fontSize", 19);
      await flushMicrotasks();
      expect(forKey()).toHaveLength(0);
    });

    it("set(): a SUPERSEDED rejection never revives a warning the newer write already cleared", async () => {
      // set() is fire-and-forget by contract, so two rapid writes to one key can settle out of
      // order. Without a per-key ticket the older failure would publish a warning describing a
      // value the file no longer holds.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const gates: Array<() => void> = [];
      let call = 0;
      const invoke = (cmd: string): Promise<unknown> => {
        if (cmd === "config_read")
          return Promise.resolve({ exists: true, path: "/c.toml", values: {}, warnings: [] });
        if (cmd === "config_write") {
          const mine = call++;
          // First write REJECTS, second RESOLVES — but the first settles last.
          return new Promise((resolve, reject) => {
            gates.push(() => (mine === 0 ? reject(new Error("stale")) : resolve(null)));
          });
        }
        return Promise.reject(new Error(`unexpected ${cmd}`));
      };
      await runtime.hydrate({ invoke, bus: fakeListenBus(), storage: fakeStorage() });
      const store = runtime.makeStore(fakeBus(), "settings");

      store.set("terminal.fontSize", 18); // ticket 1 — will fail
      store.set("terminal.fontSize", 19); // ticket 2 — will succeed
      gates[1]();                          // the NEWER write settles first
      await flushMicrotasks();
      gates[0]();                          // the older failure settles afterwards
      await flushMicrotasks();

      expect(
        runtime.getConfigWarnings().filter((w) => w.message.includes("terminal.fontSize")),
      ).toHaveLength(0);
    });

    it("theme materialization: a rejected first-run write authors the keyed warning", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      // No theme in the file at all ⇒ hydration derives one and writes it through (trmx-53).
      const backend = fakeConfigBackend({ values: {} }, { failWrites: true });
      await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
      await flushMicrotasks();
      const warned = runtime.getConfigWarnings().filter((w) => w.message.includes("appearance.theme"));
      expect(warned).toHaveLength(1);
      expect(warned[0].source).toBe("client");
    });

    it("legacy migration: goes through the SAME ticket, so a concurrent set() is not clobbered", async () => {
      // Step-9 finding 2: the migration used to keep an inline copy of the rejection handling and
      // never touched writeSeq, so its verdict could overwrite a newer set()'s. Here the
      // migration write FAILS while a later set() SUCCEEDS — the newer write must own the verdict.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const gates: Array<() => void> = [];
      let call = 0;
      const invoke = (cmd: string): Promise<unknown> => {
        if (cmd === "config_read")
          return Promise.resolve({ exists: false, path: "/c.toml", values: {}, warnings: [] });
        if (cmd === "config_write") {
          const mine = call++;
          return new Promise((resolve, reject) => {
            gates.push(() => (mine === 0 ? reject(new Error("migration boom")) : resolve(null)));
          });
        }
        return Promise.reject(new Error(`unexpected ${cmd}`));
      };
      const storage = fakeStorage({ "termixion.terminal.fontSize": "17" });
      const hydrating = runtime.hydrate({ invoke, bus: fakeListenBus(), storage });
      await flushMicrotasks();

      // A normal write for the SAME key supersedes the in-flight migration write.
      const store = runtime.makeStore(fakeBus(), "settings");
      store.set("terminal.fontSize", 20);
      await flushMicrotasks();

      gates[1]?.(); // the newer set() lands
      await flushMicrotasks();
      gates[0]?.(); // the older migration write fails afterwards
      await flushMicrotasks();
      gates.slice(2).forEach((g) => g());
      await hydrating.catch(() => {});
      await flushMicrotasks();

      expect(
        runtime.getConfigWarnings().filter((w) => w.message.includes("terminal.fontSize")),
      ).toHaveLength(0);
    });

    it("legacy migration: a rejected write authors the keyed warning and keeps the legacy key", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const storage = fakeStorage({ "termixion.terminal.fontSize": "17" });
      // exists:false ⇒ the pre-FR-13 migration runs; every config_write rejects.
      const backend = fakeConfigBackend({ exists: false, values: {} }, { failWrites: true });
      await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage });
      await flushMicrotasks();
      const warned = runtime.getConfigWarnings().filter((w) => w.message.includes("terminal.fontSize"));
      expect(warned).toHaveLength(1);
      // A failed write must leave the legacy key for a retry on the next launch.
      expect(storage.getItem("termixion.terminal.fontSize")).toBe("17");
    });
  });

  // trmx-238 (M15/M18): the two new backend warning variants must render as sentences. The
  // renderer is private, so this goes through the PUBLIC surface — a config:warnings broadcast
  // followed by runtime.getConfigWarnings() — which is also what the UI actually observes.
  describe("trmx-238: the new ConfigWarning variants render readably", () => {
    it("renders Unreadable and EnhancementsUnavailable instead of raw JSON", async () => {
      const bus = fakeListenBus();
      await runtime.hydrate({
        invoke: fakeConfigBackend().invoke,
        bus,
        storage: fakeStorage(),
      });
      bus.fire(CONFIG_WARNINGS_EVENT, [
        { type: "Unreadable", message: "Permission denied (os error 13)" },
        { type: "EnhancementsUnavailable", reason: "no starship binary found" },
      ]);
      const messages = runtime.getConfigWarnings().map((w) => w.message);
      expect(messages[0]).toContain("Permission denied");
      expect(messages[0]).not.toContain("{");
      expect(messages[1]).toContain("no starship binary found");
      expect(messages[1]).not.toContain("{");
    });

    it("an unreadable file (exists:true) does NOT run the legacy migration", async () => {
      // M15's second half: config_read used to map EACCES to exists:false, and exists:false is
      // exactly the flag that decides the one-time pre-FR-13 migration is due. A permissions
      // accident must not re-run it.
      const storage = fakeStorage({ "termixion.terminal.fontSize": "17" });
      const backend = fakeConfigBackend({
        exists: true,
        values: {},
        warnings: [{ type: "Unreadable", message: "Permission denied (os error 13)" }],
      });
      await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage });
      await flushMicrotasks();
      expect(backend.writes().some((w) => w.key === "terminal.fontSize")).toBe(false);
      expect(storage.getItem("termixion.terminal.fontSize")).toBe("17");
    });
  });

  it("resetAll clears the snapshot to defaults, invokes config_reset_all, and broadcasts each default", async () => {
    const backend = fakeConfigBackend({ values: { "appearance.theme": "solarized" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = runtime.makeStore(bus, "settings");
    store.set("terminal.fontSize", 30);
    localStorage.setItem("termixion.update.lastCheckAt", "2026-07-01T00:00:00Z");
    bus.events.length = 0;
    store.resetAll();
    try {
      expect(store.get("terminal.fontSize")).toBe(12);
      // Post-reset the theme derives afresh, like a first run (jsdom → night).
      expect(store.get("appearance.theme")).toBe("night");
      expect(backend.calls.some((c) => c.cmd === "config_reset_all")).toBe(true);
      expect(localStorage.getItem("termixion.update.lastCheckAt")).toBeNull();
      const emitted = bus.events.filter((e) => e.event === SETTINGS_CHANGED_EVENT);
      const emittedKeys = emitted.map((e) => (e.payload as { key: string }).key).sort();
      expect(emittedKeys).toEqual([...SETTING_KEYS].sort());
      const themeEvent = emitted.find(
        (e) => (e.payload as { key: string }).key === "appearance.theme",
      );
      expect((themeEvent?.payload as { value: unknown }).value).toBe("night");
    } finally {
      localStorage.removeItem("termixion.update.lastCheckAt");
    }
  });

  it("lastCheckAt bookkeeping stays on localStorage (internal, not user config — docs/config.md)", () => {
    const store = runtime.makeStore(fakeBus(), "main");
    try {
      expect(store.loadLastCheckAt()).toBeNull();
      store.saveLastCheckAt("2026-07-02T01:02:03Z");
      expect(localStorage.getItem("termixion.update.lastCheckAt")).toBe("2026-07-02T01:02:03Z");
      expect(store.loadLastCheckAt()).toBe("2026-07-02T01:02:03Z");
    } finally {
      localStorage.removeItem("termixion.update.lastCheckAt");
    }
  });
});

// trmx-148: the About row's backend-side "Open config file" — a plain command invoke
// (config_open_file) riding the hydration-injected channel, mirroring the themes/scripts
// open-dir seam. Unlike the fire-and-forget config_write path, its rejection PROPAGATES to the
// caller so the row can surface the failure instead of silently discarding it.
describe("openConfigFile (trmx-148)", () => {
  /** A backend that resolves config_read + config_open_file; everything else is unexpected. */
  function fakeOpenBackend(opts: { failOpen?: boolean } = {}) {
    const calls: string[] = [];
    const invoke = (cmd: string): Promise<unknown> => {
      calls.push(cmd);
      if (cmd === "config_read") {
        return Promise.resolve({
          exists: true,
          path: "/tmp/termixion/config.toml",
          values: { "appearance.theme": "night" },
          warnings: [],
        });
      }
      if (cmd === "config_open_file") {
        return opts.failOpen
          ? Promise.reject(new Error("opener denied"))
          : Promise.resolve(null);
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    };
    return { invoke, calls };
  }

  it("invokes config_open_file through the hydration-injected invoke and resolves void", async () => {
    const backend = fakeOpenBackend();
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    await expect(runtime.openConfigFile()).resolves.toBeUndefined();
    expect(backend.calls).toContain("config_open_file");
  });

  it("PROPAGATES a rejection to the caller (unlike the fire-and-forget config_write path)", async () => {
    const backend = fakeOpenBackend({ failOpen: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    await expect(runtime.openConfigFile()).rejects.toThrow("opener denied");
  });
});

describe("hydrateSettings (trmx-80)", () => {
  it("seeds the snapshot from config_read values, re-validating each through the per-key semantics", async () => {
    const backend = fakeConfigBackend({
      values: {
        "update.autoCheck": false,
        "terminal.fontSize": 14,
        "terminal.fontFamily": "Menlo",
        "terminal.scrollbackLines": 250_000, // client clamps defensively even if the backend didn't
        "appearance.theme": "solarized",
      },
    });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const store = runtime.makeStore();
    expect(store.get("update.autoCheck")).toBe(false);
    expect(store.get("terminal.fontSize")).toBe(14);
    expect(store.get("terminal.fontFamily")).toBe("Menlo");
    expect(store.get("terminal.scrollbackLines")).toBe(200_000);
    expect(store.get("appearance.theme")).toBe("solarized");
    // PRESENT-ONLY: keys absent from the file stay on their defaults.
    expect(store.get("terminal.cursorStyle")).toBe("underline");
  });

  it("an INVALID config-origin value falls back to the default and records a CLIENT warning", async () => {
    const backend = fakeConfigBackend({
      values: {
        "terminal.cursorBlink": "yes", // string where a boolean is required
        "update.checkFrequency": "hourly", // not an enum member
        "terminal.fontSize": "big", // string where a number is required
        "appearance.theme": "night",
      },
    });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const store = runtime.makeStore();
    expect(store.get("terminal.cursorBlink")).toBe(false);
    expect(store.get("update.checkFrequency")).toBe("on-startup");
    expect(store.get("terminal.fontSize")).toBe(12);
    const client = runtime.getConfigWarnings().filter((w) => w.source === "client");
    expect(client).toHaveLength(3);
    expect(client.map((w) => w.message).join("\n")).toContain("terminal.cursorBlink");
    expect(client.map((w) => w.message).join("\n")).toContain("update.checkFrequency");
    expect(client.map((w) => w.message).join("\n")).toContain("terminal.fontSize");
  });

  it("stores the config path and renders backend warnings human-readably (source: file)", async () => {
    const backend = fakeConfigBackend({
      path: "/Users/me/.config/termixion/config.toml",
      values: { "appearance.theme": "night" },
      warnings: [
        { type: "SyntaxError", message: "expected `=` at line 3" },
        { type: "UnknownKey", key: "terminal.zoom" },
        { type: "InvalidValue", key: "terminal.cursorStyle", got: "sparkles", expected: "bar|block|underline" },
        { type: "OutOfRange", key: "terminal.fontSize", got: 99, clamped_to: 72 },
      ],
    });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.getConfigFilePath()).toBe("/Users/me/.config/termixion/config.toml");
    const file = runtime.getConfigWarnings().filter((w) => w.source === "file");
    expect(file).toHaveLength(4);
    const text = file.map((w) => w.message).join("\n");
    expect(text).toContain("expected `=` at line 3");
    expect(text).toContain("terminal.zoom");
    expect(text).toContain("sparkles");
    expect(text).toContain("72");
  });

  it("never throws when the invoke rejects (plain browser/jsdom): defaults, no migration, null path", async () => {
    const storage = fakeStorage({ "termixion.terminal.cursorStyle": "block" });
    const backend = fakeConfigBackend({}, { failRead: true });
    await expect(
      runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage }),
    ).resolves.toBeUndefined();
    expect(runtime.makeStore().get("terminal.cursorStyle")).toBe("underline");
    expect(backend.writes()).toEqual([]); // no migration on the rejection path
    expect(storage.data.has("termixion.terminal.cursorStyle")).toBe(true);
    expect(runtime.getConfigFilePath()).toBeNull();
    expect(runtime.getConfigWarnings()).toEqual([]);
  });

  it("never throws when the invoke throws SYNCHRONOUSLY (no Tauri internals at all)", async () => {
    await expect(
      runtime.hydrate({
        invoke: () => {
          throw new Error("window.__TAURI_INTERNALS__ is undefined");
        },
        bus: fakeListenBus(),
        storage: fakeStorage(),
      }),
    ).resolves.toBeUndefined();
  });

  it("subscribes ONCE to settings:changed — a second hydrate does not double-subscribe", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    expect(bus.listened.filter((e) => e === SETTINGS_CHANGED_EVENT)).toHaveLength(1);
  });
});

describe("live snapshot updates over the bus (trmx-80)", () => {
  it("keeps the snapshot current for other-window and config-file-watcher changes", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = runtime.makeStore();
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "terminal.fontSize", value: 18, source: "config-file" });
    expect(store.get("terminal.fontSize")).toBe(18);
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "terminal.cursorStyle", value: "bar", source: "settings" });
    expect(store.get("terminal.cursorStyle")).toBe("bar");
  });

  it("re-validates config-file-origin values: invalid → ignored + client warning", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = runtime.makeStore();
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "terminal.fontSize", value: 18, source: "config-file" });
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "terminal.fontSize", value: "huge", source: "config-file" });
    expect(store.get("terminal.fontSize")).toBe(18); // the junk value never landed
    expect(
      runtime.getConfigWarnings().some((w) => w.source === "client" && w.message.includes("terminal.fontSize")),
    ).toBe(true);
    // Junk payloads and unknown keys are inert.
    bus.fire(SETTINGS_CHANGED_EVENT, "garbage");
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "not.a.key", value: 1, source: "config-file" });
    expect(store.get("terminal.fontSize")).toBe(18);
  });

  it("an invalid config-file theme applies the DERIVED DEFAULT — client warning, no write", async () => {
    // The backend cannot validate theme IDs (any string is a valid TOML Str) — only the client
    // can. A broken live theme must serve the derived default so gets stay consistent with what
    // a fresh parse of the file would yield, NOT the stale previous value.
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "solarized" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = runtime.makeStore();
    expect(store.get("appearance.theme")).toBe("solarized");
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "nihgt",
      source: "config-file",
    });
    expect(store.get("appearance.theme")).toBe("night"); // jsdom derivation → night
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("appearance.theme"),
      ),
    ).toBe(true);
    // Nothing is written back — the user's (typo'd) file value stays theirs to fix.
    expect(backend.writes().some((w) => w.key === "appearance.theme")).toBe(false);
    // A NON-config-file source with an invalid theme stays inert (untrusted junk, no warning).
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "appearance.theme", value: "neon", source: "settings" });
    expect(store.get("appearance.theme")).toBe("night");
  });

  it("a fractional number over the bus never reaches the snapshot (integers only)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = runtime.makeStore();
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "terminal.fontSize", value: 12.5, source: "settings" });
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "terminal.scrollbackLines",
      value: 100.5,
      source: "config-file",
    });
    expect(store.get("terminal.fontSize")).toBe(12);
    expect(store.get("terminal.scrollbackLines")).toBe(10_000);
  });

  it("config:warnings broadcasts REPLACE the stored warnings (a re-parse supersedes older ones)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({
      values: { "appearance.theme": "night" },
      warnings: [{ type: "UnknownKey", key: "old.key" }],
    });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    expect(runtime.getConfigWarnings().map((w) => w.message).join()).toContain("old.key");
    bus.fire(CONFIG_WARNINGS_EVENT, [{ type: "UnknownKey", key: "new.key" }]);
    const messages = runtime.getConfigWarnings().map((w) => w.message).join();
    expect(messages).toContain("new.key");
    expect(messages).not.toContain("old.key");
  });
});

// trmx-80 review R2: the store is the ONE warnings authority — the UI subscribes to it instead of
// racing the raw config:warnings event, so it sees EVERY change: backend re-parses (including the
// empty set that clears a stale banner) and client-authored warnings alike.
describe("onConfigWarningsChanged (trmx-80)", () => {
  it("notifies on a config:warnings broadcast INCLUDING an empty one (the banner-clear path)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const seen: ConfigWarningItem[][] = [];
    const off = runtime.onConfigWarningsChanged((items) => void seen.push(items));
    bus.fire(CONFIG_WARNINGS_EVENT, [{ type: "UnknownKey", key: "bad.key" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].map((w) => w.message).join()).toContain("bad.key");
    // The user fixed the file: the EMPTY set still notifies, so the banner can clear.
    bus.fire(CONFIG_WARNINGS_EVENT, []);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([]);
    off();
    bus.fire(CONFIG_WARNINGS_EVENT, [{ type: "UnknownKey", key: "later.key" }]);
    expect(seen).toHaveLength(2); // unsubscribed — no further notifications
  });

  it("notifies when a CLIENT warning is authored (an invalid config-file value)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const seen: ConfigWarningItem[][] = [];
    runtime.onConfigWarningsChanged((items) => void seen.push(items));
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "terminal.fontSize",
      value: "huge",
      source: "config-file",
    });
    expect(seen).toHaveLength(1);
    expect(
      seen[0].some((w) => w.source === "client" && w.message.includes("terminal.fontSize")),
    ).toBe(true);
  });
});

// trmx-80 review R2 (round 2): FILE warnings and CLIENT warnings are separate ledgers. The
// backend's config:warnings event describes only what the CORE parser can see, so it replaces the
// FILE set wholesale — it must never wipe a CLIENT warning (e.g. an invalid theme id, which the
// backend cannot validate). A client warning is keyed by its registry key and superseded only by
// a NEW VALUE for that key: invalid → (re)set, valid → cleared.
describe("file vs client warning ledgers (trmx-80)", () => {
  it("a client warning SURVIVES the backend's empty config:warnings that follows it", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    // The watcher's sequence for a hand edit that breaks the theme: settings:changed (invalid
    // theme id — the CLIENT authors the warning) then config:warnings [] (the core parsed the
    // file clean; a theme is a free string to the backend).
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "nihgt",
      source: "config-file",
    });
    bus.fire(CONFIG_WARNINGS_EVENT, []);
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("appearance.theme"),
      ),
    ).toBe(true);
    // Re-authoring the SAME key replaces, never accumulates: still exactly one client warning.
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "wrogn-again",
      source: "config-file",
    });
    expect(runtime.getConfigWarnings().filter((w) => w.source === "client")).toHaveLength(1);
    // A LATER VALID value for the key is what clears it — the merged list goes empty.
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "solarized",
      source: "config-file",
    });
    bus.fire(CONFIG_WARNINGS_EVENT, []);
    expect(runtime.getConfigWarnings()).toEqual([]);
  });

  it("hydration's client warning coexists with the file set and clears on a later valid value", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({
      values: { "appearance.theme": "hotdog-stand" },
      warnings: [{ type: "UnknownKey", key: "old.key" }],
    });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    // The merged list: FILE warnings first, then CLIENT warnings.
    const merged = runtime.getConfigWarnings();
    expect(merged.map((w) => w.source)).toEqual(["file", "client"]);
    expect(merged[0].message).toContain("old.key");
    expect(merged[1].message).toContain("appearance.theme");
    // The backend re-parses clean: the FILE set empties, the CLIENT warning survives.
    bus.fire(CONFIG_WARNINGS_EVENT, []);
    expect(runtime.getConfigWarnings().map((w) => w.source)).toEqual(["client"]);
    // The user fixes the theme: the valid value clears exactly that key's client warning.
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "gruvbox",
      source: "config-file",
    });
    expect(runtime.getConfigWarnings()).toEqual([]);
  });

  it("notifies subscribers when a valid value clears a client warning (merged result changed)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "nihgt",
      source: "config-file",
    });
    const seen: ConfigWarningItem[][] = [];
    runtime.onConfigWarningsChanged((items) => void seen.push(items));
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "gruvbox",
      source: "config-file",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([]);
  });
});

describe("legacy localStorage migration (trmx-80 T3b)", () => {
  it("fresh install: no legacy keys → no migration writes (only the theme materialization)", async () => {
    const backend = fakeConfigBackend({ exists: false, values: {} });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(backend.writes().map((w) => w.key)).toEqual(["appearance.theme"]);
  });

  it("legacy install: parsed values land as config_write calls and the legacy keys are removed", async () => {
    const storage = fakeStorage({
      "termixion.update.autoCheck": "false",
      "termixion.terminal.cursorStyle": "block",
      "termixion.terminal.scrollbackLines": "999999", // clamped through the same per-key parse
      "termixion.appearance.theme": "solarized",
      "termixion.update.lastCheckAt": "2026-07-01T00:00:00Z", // NOT migrated, stays forever
    });
    const backend = fakeConfigBackend({ exists: false, values: {} });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage });
    const writes = backend.writes();
    expect(writes).toContainEqual({ key: "update.autoCheck", value: false });
    expect(writes).toContainEqual({ key: "terminal.cursorStyle", value: "block" });
    expect(writes).toContainEqual({ key: "terminal.scrollbackLines", value: 200_000 });
    expect(writes).toContainEqual({ key: "appearance.theme", value: "solarized" });
    // The migrated theme suppresses materialization: exactly ONE appearance.theme write.
    expect(writes.filter((w) => w.key === "appearance.theme")).toHaveLength(1);
    // lastCheckAt is bookkeeping, not user config: never written to the file, never removed.
    expect(writes.some((w) => w.key === "update.lastCheckAt")).toBe(false);
    expect(storage.data.has("termixion.update.lastCheckAt")).toBe(true);
    // Migrated keys are gone from localStorage…
    expect(storage.data.has("termixion.update.autoCheck")).toBe(false);
    expect(storage.data.has("termixion.terminal.cursorStyle")).toBe(false);
    expect(storage.data.has("termixion.appearance.theme")).toBe(false);
    // …and the snapshot serves the migrated values.
    const store = runtime.makeStore();
    expect(store.get("update.autoCheck")).toBe(false);
    expect(store.get("terminal.cursorStyle")).toBe("block");
    expect(store.get("appearance.theme")).toBe("solarized");
  });

  it("both present: the FILE wins — no migration, legacy keys untouched", async () => {
    const storage = fakeStorage({ "termixion.terminal.cursorStyle": "block" });
    const backend = fakeConfigBackend({
      exists: true,
      values: { "terminal.cursorStyle": "bar", "appearance.theme": "night" },
    });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage });
    expect(runtime.makeStore().get("terminal.cursorStyle")).toBe("bar");
    expect(backend.writes().some((w) => w.key === "terminal.cursorStyle")).toBe(false);
    expect(storage.data.has("termixion.terminal.cursorStyle")).toBe(true);
  });

  it("write failure: the legacy keys are NOT removed (retried next launch)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = fakeStorage({ "termixion.terminal.cursorStyle": "block" });
    const backend = fakeConfigBackend({ exists: false, values: {} }, { failWrites: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage });
    expect(storage.data.has("termixion.terminal.cursorStyle")).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe("theme materialization at hydration (trmx-80, superseding get()-time trmx-53)", () => {
  it("theme absent from the file (and not migrated): derives, seeds, and writes through", async () => {
    const backend = fakeConfigBackend({ exists: true, values: {} });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("appearance.theme")).toBe("night"); // jsdom derives night
    expect(backend.writes()).toContainEqual({ key: "appearance.theme", value: "night" });
  });

  it("theme present in the file: no materialization write", async () => {
    const backend = fakeConfigBackend({ exists: true, values: { "appearance.theme": "gruvbox" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("appearance.theme")).toBe("gruvbox");
    expect(backend.writes().some((w) => w.key === "appearance.theme")).toBe(false);
  });

  it("a failing write-through keeps the derived value in the snapshot and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ exists: true, values: {} }, { failWrites: true });
    await expect(
      runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() }),
    ).resolves.toBeUndefined();
    expect(runtime.makeStore().get("appearance.theme")).toBe("night");
    expect(warn).toHaveBeenCalled();
  });

  it("theme PRESENT but invalid: serves the derived default, warns, and NEVER writes the file", async () => {
    // Presence ≠ validity: a typo'd theme is the user's value to fix — materialization must not
    // clobber it with a derived write-through (that is only for the truly-absent key).
    const backend = fakeConfigBackend({
      exists: true,
      values: { "appearance.theme": "hotdog-stand" },
    });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(backend.writes().some((w) => w.key === "appearance.theme")).toBe(false);
    // Reads serve the derived default for this session (jsdom derivation → night).
    expect(runtime.makeStore().get("appearance.theme")).toBe("night");
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("appearance.theme"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// trmx-202: the four REMOVED built-ins (white/paper/mint/sepia) are recognized legacy ids, not
// junk — every persisted-theme path serves the derived default for them SILENTLY (no client
// warning, no repair write), while truly unknown junk keeps the warning behavior pinned above.
// (Both-appearance derivation is defaultTheme.test's job; jsdom here derives night.)
describe("removed built-in ids fall back silently (trmx-202)", () => {
  const REMOVED = ["white", "paper", "mint", "sepia"] as const;
  const THEME_STORAGE_KEY = "termixion.appearance.theme";

  it("hydration with a removed id in the config file: derived default, no warning, no write", async () => {
    for (const id of REMOVED) {
      const backend = fakeConfigBackend({ exists: true, values: { "appearance.theme": id } });
      await runtime.hydrate({
        invoke: backend.invoke,
        bus: fakeListenBus(),
        storage: fakeStorage(),
      });
      expect(runtime.makeStore().get("appearance.theme")).toBe("night");
      expect(backend.writes().some((w) => w.key === "appearance.theme")).toBe(false);
      expect(
        runtime.getConfigWarnings().some(
          (w) => w.source === "client" && w.message.includes("appearance.theme"),
        ),
      ).toBe(false);
    }
  });

  it("junk in the config file still warns (the removed-id special case never widens)", async () => {
    const backend = fakeConfigBackend({
      exists: true,
      values: { "appearance.theme": "hotdog-stand" },
    });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("appearance.theme"),
      ),
    ).toBe(true);
  });

  it("a live removed-id config edit seeds the default, CLEARS a prior theme warning, writes nothing", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ exists: true, values: { "appearance.theme": "night" } });
    await runtime.hydrate({ invoke: backend.invoke, bus, storage: fakeStorage() });
    // A hand edit breaks the theme (junk): the client authors the warning…
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "nihgt",
      source: "config-file",
    });
    expect(runtime.getConfigWarnings().filter((w) => w.source === "client")).toHaveLength(1);
    // …then a REMOVED id arrives (a hand edit, or the watcher broadcasting the Rust default
    // "white" after the key is deleted): silent — derived default served, the stale warning
    // cleared, still no write.
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "sepia",
      source: "config-file",
    });
    expect(runtime.makeStore().get("appearance.theme")).toBe("night");
    expect(runtime.getConfigWarnings().filter((w) => w.source === "client")).toHaveLength(0);
    expect(backend.writes().some((w) => w.key === "appearance.theme")).toBe(false);
  });

  it("legacy migration normalizes a removed id into the one file-creation write, silently", async () => {
    // No config file yet (pre-FR-13 install): migration parses the legacy value silently and its
    // config_write IS the file-creation write — the documented exemption from no-repair-write.
    const backend = fakeConfigBackend({ exists: false });
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: "sepia" });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage });
    expect(runtime.makeStore().get("appearance.theme")).toBe("night");
    const themeWrites = backend.writes().filter((w) => w.key === "appearance.theme");
    expect(themeWrites).toEqual([{ key: "appearance.theme", value: "night" }]);
    expect(
      runtime.getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("appearance.theme"),
      ),
    ).toBe(false);
  });

  it("migration path: a persisted removed id silently re-derives", async () => {
    const backend = fakeConfigBackend({ exists: false, values: {} });
    await runtime.hydrate({
      invoke: backend.invoke,
      bus: fakeListenBus(),
      storage: fakeStorage({ [THEME_STORAGE_KEY]: "sepia" }),
    });
    expect(runtime.makeStore().get("appearance.theme")).toBe("night");
  });

  // Both-appearance coverage: a LIGHT OS derives Catppuccin Latte for the same removed ids —
  // window.matchMedia is stubbed (present + matches:false = light) and restored per test.
  describe("on a light OS (matchMedia stubbed)", () => {
    const lightMatchMedia = ((query: string) =>
      ({ matches: false, media: query }) as MediaQueryList) as typeof window.matchMedia;

    it("hydration and read-time serve catppuccin-latte for removed ids, silently", async () => {
      const original = window.matchMedia;
      window.matchMedia = lightMatchMedia;
      try {
        const backend = fakeConfigBackend({
          exists: true,
          values: { "appearance.theme": "sepia" },
        });
        await runtime.hydrate({
          invoke: backend.invoke,
          bus: fakeListenBus(),
          storage: fakeStorage(),
        });
        expect(runtime.makeStore().get("appearance.theme")).toBe("catppuccin-latte");
        expect(backend.writes().some((w) => w.key === "appearance.theme")).toBe(false);
        expect(
          runtime.getConfigWarnings().some(
            (w) => w.source === "client" && w.message.includes("appearance.theme"),
          ),
        ).toBe(false);
        // …and the migration path re-derives the same way for a removed id in localStorage.
        runtime.dispose();
        const migrated = fakeConfigBackend({ exists: false, values: {} });
        await runtime.hydrate({
          invoke: migrated.invoke,
          bus: fakeListenBus(),
          storage: fakeStorage({ [THEME_STORAGE_KEY]: "white" }),
        });
        expect(runtime.makeStore().get("appearance.theme")).toBe("catppuccin-latte");
      } finally {
        window.matchMedia = original;
      }
    });
  });
});

// trmx-225: opt-in focus-follows-mouse — defaults OFF; boolean set/get round-trips.
describe("terminal.focusFollowsMouse (trmx-225)", () => {
  it("defaults to false and round-trips a boolean", () => {
    const store = runtime.makeStore();
    expect(store.get("terminal.focusFollowsMouse")).toBe(false);
    store.set("terminal.focusFollowsMouse", true);
    expect(store.get("terminal.focusFollowsMouse")).toBe(true);
  });

  it("migrates from EXACTLY termixion.terminal.focusFollowsMouse", async () => {
    // The legacy STORAGE_KEYS entry is still load-bearing — not for reads any more (T3.5 deleted
    // that backend), but for the one-time migration of a pre-FR-13 install. A typo in the key name
    // would silently strand the user's setting, so the exact string stays pinned.
    const { store, backend } = await hydrateFromLegacyKeys({
      "termixion.terminal.focusFollowsMouse": "true",
    });
    expect(store.get("terminal.focusFollowsMouse")).toBe(true);
    expect(backend.writes()).toContainEqual({ key: "terminal.focusFollowsMouse", value: true });
  });
});

// trmx-236: the About row's log-folder adapters — plain command invokes (log_dir / log_open_dir)
// riding the hydration-injected channel, the openConfigFile shape: rejections PROPAGATE.
describe("log folder adapters (trmx-236)", () => {
  function fakeLogBackend(opts: { failOpen?: boolean } = {}) {
    const calls: string[] = [];
    const invoke = (cmd: string): Promise<unknown> => {
      calls.push(cmd);
      if (cmd === "config_read") {
        return Promise.resolve({ exists: true, path: "/tmp/termixion/config.toml", values: {}, warnings: [] });
      }
      if (cmd === "log_dir") return Promise.resolve("/Users/t/Library/Logs/dev.termixion.terminal");
      if (cmd === "log_open_dir") {
        return opts.failOpen ? Promise.reject(new Error("opener denied")) : Promise.resolve(null);
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    };
    return { invoke, calls };
  }

  it("getLogDir invokes log_dir and returns the backend-resolved path", async () => {
    const backend = fakeLogBackend();
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    await expect(runtime.getLogDir()).resolves.toBe("/Users/t/Library/Logs/dev.termixion.terminal");
    expect(backend.calls).toContain("log_dir");
  });

  it("openLogDir invokes log_open_dir and resolves void", async () => {
    const backend = fakeLogBackend();
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    await expect(runtime.openLogDir()).resolves.toBeUndefined();
    expect(backend.calls).toContain("log_open_dir");
  });

  it("openLogDir PROPAGATES a rejection so the About row can show it", async () => {
    const backend = fakeLogBackend({ failOpen: true });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    await expect(runtime.openLogDir()).rejects.toThrow("opener denied");
  });
});

// trmx-246: remote_control.socketPath is a FREE STRING (like terminal.shell) — before this fix,
// neither parse() nor coerce() had a branch for it, so both fell through to the cursor-style check
// and a configured socket path came back as the default "". The backend accepted the value all
// along; the store silently dropped it.
describe("remote_control.socketPath is a free string (trmx-246)", () => {
  it("hydration keeps a configured socket path instead of coercing it to the default", async () => {
    const backend = fakeConfigBackend({ values: { "remote_control.socketPath": "/tmp/tx.sock" } });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(runtime.makeStore().get("remote_control.socketPath")).toBe("/tmp/tx.sock");
    expect(runtime.getConfigWarnings().filter((w) => w.source === "client")).toHaveLength(0);
  });

  it("the legacy-storage migration parses the path as written", async () => {
    const storage = fakeStorage({ "termixion.remote_control.socketPath": "/tmp/legacy.sock" });
    const backend = fakeConfigBackend({ exists: false, values: {} });
    await runtime.hydrate({ invoke: backend.invoke, bus: fakeListenBus(), storage });
    expect(backend.writes()).toContainEqual({ key: "remote_control.socketPath", value: "/tmp/legacy.sock" });
    expect(runtime.makeStore().get("remote_control.socketPath")).toBe("/tmp/legacy.sock");
  });
});
