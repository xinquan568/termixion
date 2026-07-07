// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the persisted-settings registry. One enumerable place for every user-visible setting —
// defaults, parsing — so "Reset all settings" can restore *everything* and future keys can't
// silently escape it (R8: these are the failing tests written first).
//
// trmx-80 (FR-13): the VALUE backend is a module-level shared snapshot hydrated from the backend
// config file (config_read / config_write / config_reset_all) — see the "shared snapshot backend"
// blocks below. An EXPLICITLY injected storage keeps the legacy per-instance localStorage backend
// (the compat shim the settings-window UI tests still construct stores through until T3e).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeSettingsStore,
  hydrateSettings,
  isLabelOrientation,
  getConfigFilePath,
  getConfigWarnings,
  onConfigWarningsChanged,
  openConfigFile,
  __resetSettingsForTest,
  SETTING_KEYS,
  SETTING_DEFAULTS,
  SETTING_RANGES,
  SETTINGS_CHANGED_EVENT,
  CONFIG_WARNINGS_EVENT,
  type ConfigWarningItem,
  type KeyValueStore,
  type SettingsBus,
  type SettingsListenBus,
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

// Every test starts from an empty module snapshot (the snapshot is module-level BY DESIGN — all
// storage-less stores share it — so tests must reset it explicitly).
beforeEach(() => {
  __resetSettingsForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Legacy storage-backed mode (an EXPLICITLY injected storage): the pre-trmx-80 behavior, kept as
// a per-instance compat shim for the settings-window UI tests until T3e reworks them.
// ---------------------------------------------------------------------------------------------

describe("settingsStore defaults (legacy storage mode)", () => {
  it("serves the registry defaults (trmx-51; blink off since trmx-55) when nothing is persisted", () => {
    const store = makeSettingsStore(fakeStorage());
    expect(store.get("update.autoCheck")).toBe(true);
    expect(store.get("update.checkFrequency")).toBe("on-startup");
    expect(store.get("update.autoDownload")).toBe(true);
    expect(store.get("terminal.cursorStyle")).toBe("underline");
    expect(store.get("terminal.cursorBlink")).toBe(false);
    // trmx-80 (FR-13): the scrollback/font trio.
    expect(store.get("terminal.scrollbackLines")).toBe(10_000);
    expect(store.get("terminal.fontFamily")).toBe("");
    expect(store.get("terminal.fontSize")).toBe(12);
  });

  it("round-trips every setting", () => {
    const store = makeSettingsStore(fakeStorage());
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

  it("honors the legacy trmx-48 auto-check storage key", () => {
    const store = makeSettingsStore(fakeStorage({ "termixion.update.autoCheck": "false" }));
    expect(store.get("update.autoCheck")).toBe(false);
  });

  it("treats garbage persisted values as the default", () => {
    const store = makeSettingsStore(
      fakeStorage({
        "termixion.terminal.cursorStyle": "sparkles",
        "termixion.update.checkFrequency": "hourly",
        "termixion.terminal.cursorBlink": "maybe",
        "termixion.update.autoCheck": "maybe",
      }),
    );
    expect(store.get("terminal.cursorStyle")).toBe("underline");
    expect(store.get("update.checkFrequency")).toBe("on-startup");
    // trmx-55: boolean reads are default-aware — only the "true"/"false" literals parse; anything
    // else lands on the key's own default ("maybe" → blink off, but auto-check stays on).
    expect(store.get("terminal.cursorBlink")).toBe(false);
    expect(store.get("update.autoCheck")).toBe(true);
  });

  it("parses and CLAMPS numbers; junk (including the empty string) falls to the default", () => {
    // trmx-80: the number branch of parse — clamp on read, junk → default (docs/config.md ranges).
    const clamped = makeSettingsStore(
      fakeStorage({
        "termixion.terminal.scrollbackLines": "999999",
        "termixion.terminal.fontSize": "999",
      }),
    );
    expect(clamped.get("terminal.scrollbackLines")).toBe(200_000);
    expect(clamped.get("terminal.fontSize")).toBe(72);
    const junk = makeSettingsStore(
      fakeStorage({
        "termixion.terminal.scrollbackLines": "lots",
        "termixion.terminal.fontSize": "",
      }),
    );
    expect(junk.get("terminal.scrollbackLines")).toBe(10_000);
    expect(junk.get("terminal.fontSize")).toBe(12);
    const low = makeSettingsStore(
      fakeStorage({
        "termixion.terminal.scrollbackLines": "-5",
        "termixion.terminal.fontSize": "1",
      }),
    );
    expect(low.get("terminal.scrollbackLines")).toBe(0);
    expect(low.get("terminal.fontSize")).toBe(6);
    // Integers ONLY (the backend contract): a fractional value is invalid → the default.
    const fractional = makeSettingsStore(
      fakeStorage({
        "termixion.terminal.scrollbackLines": "12.5",
        "termixion.terminal.fontSize": "9.75",
      }),
    );
    expect(fractional.get("terminal.scrollbackLines")).toBe(10_000);
    expect(fractional.get("terminal.fontSize")).toBe(12);
  });

  it("parses only the boolean literals — explicit choices survive in either direction", () => {
    const store = makeSettingsStore(
      fakeStorage({
        "termixion.terminal.cursorBlink": "true",
        "termixion.update.autoDownload": "false",
      }),
    );
    expect(store.get("terminal.cursorBlink")).toBe(true);
    expect(store.get("update.autoDownload")).toBe(false);
  });

  it("degrades to defaults when storage is throwing", () => {
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
    const store = makeSettingsStore(throwing);
    expect(store.get("terminal.cursorStyle")).toBe("underline");
    expect(() => store.set("terminal.cursorStyle", "bar")).not.toThrow();
    expect(() => store.resetAll()).not.toThrow();
  });
});

describe("settingsStore broadcasting (legacy storage mode)", () => {
  it("broadcasts settings:changed with key, value, and source on set", () => {
    const bus = fakeBus();
    const store = makeSettingsStore(fakeStorage(), bus, "settings-window");
    store.set("terminal.cursorStyle", "block");
    expect(bus.events).toEqual([
      {
        event: "settings:changed",
        payload: { key: "terminal.cursorStyle", value: "block", source: "settings-window" },
      },
    ]);
  });

  it("does not throw when the bus emit rejects or throws", () => {
    const store = makeSettingsStore(fakeStorage(), {
      emit: () => {
        throw new Error("no tauri");
      },
    });
    expect(() => store.set("terminal.cursorBlink", false)).not.toThrow();
  });
});

describe("resetAllSettings (legacy storage mode)", () => {
  it("removes every registered key including lastCheckAt", () => {
    const storage = fakeStorage();
    const store = makeSettingsStore(storage);
    store.set("terminal.cursorStyle", "bar");
    store.set("update.checkFrequency", "daily");
    store.saveLastCheckAt("2026-07-01T00:00:00Z");
    expect(storage.data.size).toBeGreaterThan(0);
    store.resetAll();
    expect(storage.data.size).toBe(0);
    expect(store.get("terminal.cursorStyle")).toBe("underline");
    expect(store.loadLastCheckAt()).toBeNull();
  });

  it("broadcasts the DEFAULT value for every user-visible setting — the emitted key set equals the registry", () => {
    const bus = fakeBus();
    const store = makeSettingsStore(fakeStorage(), bus, "settings-window");
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

describe("lastCheckAt bookkeeping (legacy storage mode)", () => {
  it("round-trips and defaults to null", () => {
    const store = makeSettingsStore(fakeStorage());
    expect(store.loadLastCheckAt()).toBeNull();
    store.saveLastCheckAt("2026-07-02T01:02:03Z");
    expect(store.loadLastCheckAt()).toBe("2026-07-02T01:02:03Z");
  });
});

describe("registry shape", () => {
  it("exposes the enumerable user-visible key set (trmx-51 + theme trmx-53 + FR-13 trio trmx-80 + tab bar trmx-81/82 + activity trmx-91)", () => {
    expect([...SETTING_KEYS].sort()).toEqual(
      [
        "update.autoCheck",
        "update.checkFrequency",
        "update.autoDownload",
        "terminal.cursorStyle",
        "terminal.cursorBlink",
        "terminal.activityIndicator",
        "terminal.confirmClose",
        "terminal.copyOnSelect",
        "terminal.scrollbackLines",
        "terminal.fontFamily",
        "terminal.fontSize",
        "appearance.theme",
        "tabs.barPosition",
        "tabs.sideLabelOrientation",
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
  it("defaults to \"\" in both backends", () => {
    expect(makeSettingsStore(fakeStorage()).get("scripts.startup")).toBe("");
    expect(makeSettingsStore().get("scripts.startup")).toBe(""); // snapshot, pre-hydration
  });

  it("round-trips an arbitrary path verbatim (legacy storage mode)", () => {
    const store = makeSettingsStore(fakeStorage());
    store.set("scripts.startup", "work/proj-x.sh");
    expect(store.get("scripts.startup")).toBe("work/proj-x.sh");
    store.set("scripts.startup", "");
    expect(store.get("scripts.startup")).toBe("");
  });

  it("reads an injected legacy-storage path unchanged (not coerced to a default)", () => {
    const store = makeSettingsStore(
      fakeStorage({ "termixion.scripts.startup": "demo/my proj.sh" }),
    );
    expect(store.get("scripts.startup")).toBe("demo/my proj.sh");
  });

  it("snapshot mode: set writes through config_write and broadcasts", async () => {
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = makeSettingsStore(undefined, bus, "settings");
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
  it("defaults to \"bottom\" in both backends", () => {
    expect(makeSettingsStore(fakeStorage()).get("tabs.barPosition")).toBe("bottom");
    expect(makeSettingsStore().get("tabs.barPosition")).toBe("bottom"); // snapshot, pre-hydration
  });

  it("round-trips all four positions (legacy storage mode)", () => {
    const store = makeSettingsStore(fakeStorage());
    for (const position of ["top", "bottom", "left", "right"] as const) {
      store.set("tabs.barPosition", position);
      expect(store.get("tabs.barPosition")).toBe(position);
    }
  });

  it("treats a junk persisted value as the default (enum parse-with-fallback)", () => {
    const store = makeSettingsStore(fakeStorage({ "termixion.tabs.barPosition": "middle" }));
    expect(store.get("tabs.barPosition")).toBe("bottom");
  });

  it("snapshot mode: set validates, writes through config_write, and broadcasts; junk is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = makeSettingsStore(undefined, bus, "settings");
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
    // built-in default. resolveTheme serves White for it until the scan resolves.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const store = makeSettingsStore(undefined, fakeBus(), "settings");

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
      values: { "tabs.barPosition": "top", "appearance.theme": "white" },
    });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.barPosition")).toBe("top");

    __resetSettingsForTest();
    const junk = fakeConfigBackend({
      values: { "tabs.barPosition": "diagonal", "appearance.theme": "white" },
    });
    await hydrateSettings({ invoke: junk.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.barPosition")).toBe("bottom");
    expect(
      getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("tabs.barPosition"),
      ),
    ).toBe(true);
  });

  it("live settings:changed applies a valid value; junk is inert (config-file junk warns)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = makeSettingsStore();
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "tabs.barPosition", value: "right", source: "config-file" });
    expect(store.get("tabs.barPosition")).toBe("right");
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "tabs.barPosition", value: "middle", source: "config-file" });
    expect(store.get("tabs.barPosition")).toBe("right"); // the junk value never landed
    expect(
      getConfigWarnings().some(
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
    expect(makeSettingsStore(fakeStorage()).get("tabs.sideLabelOrientation")).toBe("horizontal");
    expect(makeSettingsStore().get("tabs.sideLabelOrientation")).toBe("horizontal"); // snapshot, pre-hydration
  });

  it("round-trips both orientations (legacy storage mode)", () => {
    const store = makeSettingsStore(fakeStorage());
    for (const orientation of ["vertical", "horizontal"] as const) {
      store.set("tabs.sideLabelOrientation", orientation);
      expect(store.get("tabs.sideLabelOrientation")).toBe(orientation);
    }
  });

  it("treats a junk persisted value as the default (enum parse-with-fallback)", () => {
    const store = makeSettingsStore(
      fakeStorage({ "termixion.tabs.sideLabelOrientation": "diagonal" }),
    );
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
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = makeSettingsStore(undefined, bus, "settings");
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
      values: { "tabs.sideLabelOrientation": "vertical", "appearance.theme": "white" },
    });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.sideLabelOrientation")).toBe("vertical");

    __resetSettingsForTest();
    const junk = fakeConfigBackend({
      values: { "tabs.sideLabelOrientation": "diagonal", "appearance.theme": "white" },
    });
    await hydrateSettings({ invoke: junk.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.sideLabelOrientation")).toBe("horizontal");
    expect(
      getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("tabs.sideLabelOrientation"),
      ),
    ).toBe(true);
  });

  it("live settings:changed applies a valid value; junk is inert (config-file junk warns)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = makeSettingsStore();
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
      getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("tabs.sideLabelOrientation"),
      ),
    ).toBe(true);
  });
});

// trmx-144: terminal.confirmClose — the close-confirmation tri-state (pane/tab close + quit). A
// plain enum key exactly like terminal.cursorStyle: default "when-busy", only the three members
// ("never" | "when-busy" | "always") parse/coerce, junk falls to the default.
describe("terminal.confirmClose (trmx-144)", () => {
  it('defaults to "when-busy" in both backends', () => {
    expect(makeSettingsStore(fakeStorage()).get("terminal.confirmClose")).toBe("when-busy");
    expect(makeSettingsStore().get("terminal.confirmClose")).toBe("when-busy"); // snapshot, pre-hydration
  });

  it("round-trips all three values (legacy storage mode)", () => {
    const store = makeSettingsStore(fakeStorage());
    for (const value of ["never", "when-busy", "always"] as const) {
      store.set("terminal.confirmClose", value);
      expect(store.get("terminal.confirmClose")).toBe(value);
    }
  });

  it("treats a junk persisted value as the default (enum parse-with-fallback)", () => {
    const store = makeSettingsStore(
      fakeStorage({ "termixion.terminal.confirmClose": "sometimes" }),
    );
    expect(store.get("terminal.confirmClose")).toBe("when-busy");
  });

  it("snapshot mode: set validates, writes through config_write, and broadcasts; junk is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = makeSettingsStore(undefined, bus, "settings");
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
      values: { "terminal.confirmClose": "never", "appearance.theme": "white" },
    });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("terminal.confirmClose")).toBe("never");

    __resetSettingsForTest();
    const junk = fakeConfigBackend({
      values: { "terminal.confirmClose": "sometimes", "appearance.theme": "white" },
    });
    await hydrateSettings({ invoke: junk.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("terminal.confirmClose")).toBe("when-busy");
    expect(
      getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("terminal.confirmClose"),
      ),
    ).toBe(true);

    // Wrong TYPE entirely (a number) is rejected by coerce the same way.
    __resetSettingsForTest();
    const wrongType = fakeConfigBackend({
      values: { "terminal.confirmClose": 7, "appearance.theme": "white" },
    });
    await hydrateSettings({ invoke: wrongType.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("terminal.confirmClose")).toBe("when-busy");
  });

  it("live settings:changed applies a valid value; junk is inert (config-file junk warns)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = makeSettingsStore();
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
      getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("terminal.confirmClose"),
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
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.barPosition")).toBe("top");
    expect(backend.writes()).toEqual([]); // snapshot-only: the seed never writes a config file
  });

  it("RESOLVED config_read: the query is ignored entirely (a backend is present)", async () => {
    setSearch("?setting.tabs.barPosition=top");
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.barPosition")).toBe("bottom");
  });

  it("RESOLVED-but-junk config_read still means a backend is present: query ignored", async () => {
    setSearch("?setting.tabs.barPosition=top");
    // A junk-shaped response (not even an object) still RESOLVED — the runtime exists.
    const invoke = (cmd: string) =>
      cmd === "config_read" ? Promise.resolve("garbage") : Promise.resolve(null);
    await hydrateSettings({ invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.barPosition")).toBe("bottom");

    // Same for a resolved read whose VALUES carry junk: backend present, query ignored.
    __resetSettingsForTest();
    setSearch("?setting.tabs.barPosition=top");
    const junkValues = fakeConfigBackend({
      values: { "tabs.barPosition": "diagonal", "appearance.theme": "white" },
    });
    await hydrateSettings({ invoke: junkValues.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.barPosition")).toBe("bottom");
  });

  it("a junk query value re-validates through the registry and is ignored", async () => {
    setSearch("?setting.tabs.barPosition=middle");
    const backend = fakeConfigBackend({}, { failRead: true });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.barPosition")).toBe("bottom");
  });

  it("a disallowed setting.* key never seeds (a deliberate per-key allowlist)", async () => {
    // `sepia` (not the jsdom-derived default `night`) so a leak would be OBSERVABLE: if the
    // allowlist let appearance.theme through, the read below would serve sepia, not night.
    setSearch("?setting.appearance.theme=sepia&setting.terminal.fontSize=20");
    const backend = fakeConfigBackend({}, { failRead: true });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("appearance.theme")).toBe("night"); // the derived default
    expect(makeSettingsStore().get("terminal.fontSize")).toBe(12);
  });

  // trmx-82: the seam guards, duplicated for the widened allowlist key — the SAME
  // resolved-read-wins semantics as tabs.barPosition.
  it("trmx-82: REJECTED config_read seeds tabs.sideLabelOrientation from the query", async () => {
    setSearch("?setting.tabs.sideLabelOrientation=vertical");
    const backend = fakeConfigBackend({}, { failRead: true });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.sideLabelOrientation")).toBe("vertical");
    expect(backend.writes()).toEqual([]); // snapshot-only: the seed never writes a config file
  });

  it("trmx-82: a RESOLVED config_read ignores the tabs.sideLabelOrientation query entirely", async () => {
    setSearch("?setting.tabs.sideLabelOrientation=vertical");
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.sideLabelOrientation")).toBe("horizontal");
  });

  it("trmx-82: a junk tabs.sideLabelOrientation query value re-validates and is ignored", async () => {
    setSearch("?setting.tabs.sideLabelOrientation=diagonal");
    const backend = fakeConfigBackend({}, { failRead: true });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.sideLabelOrientation")).toBe("horizontal");
  });

  it("trmx-82: both allowlisted keys seed together on the rejection path", async () => {
    setSearch("?setting.tabs.barPosition=left&setting.tabs.sideLabelOrientation=vertical");
    const backend = fakeConfigBackend({}, { failRead: true });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("tabs.barPosition")).toBe("left");
    expect(makeSettingsStore().get("tabs.sideLabelOrientation")).toBe("vertical");
  });
});

// trmx-53: appearance.theme in LEGACY storage mode still materializes on read (unchanged shim).
describe("appearance.theme (trmx-53, legacy storage mode)", () => {
  const THEME_STORAGE_KEY = "termixion.appearance.theme";

  it("derives the first-run default (jsdom: no matchMedia → night) and materializes it", () => {
    const storage = fakeStorage();
    const store = makeSettingsStore(storage);
    expect(store.get("appearance.theme")).toBe("night");
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("night");
  });

  it("round-trips an explicit choice and treats junk as the derived default", () => {
    const store = makeSettingsStore(fakeStorage());
    store.set("appearance.theme", "sepia");
    expect(store.get("appearance.theme")).toBe("sepia");
    const junk = makeSettingsStore(fakeStorage({ [THEME_STORAGE_KEY]: "hotdog-stand" }));
    expect(junk.get("appearance.theme")).toBe("night");
  });
});

// ---------------------------------------------------------------------------------------------
// trmx-80 (FR-13): the SHARED SNAPSHOT backend — every storage-less makeSettingsStore() reads and
// writes one module-level snapshot, hydrated once from the backend config file.
// ---------------------------------------------------------------------------------------------

describe("shared snapshot backend (trmx-80)", () => {
  it("construction before hydration is safe: reads serve defaults, incl. the derived theme", () => {
    const store = makeSettingsStore(undefined, fakeBus(), "main");
    expect(store.get("update.autoCheck")).toBe(true);
    expect(store.get("terminal.scrollbackLines")).toBe(10_000);
    expect(store.get("terminal.fontFamily")).toBe("");
    expect(store.get("terminal.fontSize")).toBe(12);
    // The OS-derived theme (jsdom: no matchMedia → night) still derives through defaultFor.
    expect(store.get("appearance.theme")).toBe("night");
  });

  it("all storage-less instances share the one snapshot", async () => {
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const a = makeSettingsStore(undefined, fakeBus(), "settings");
    const b = makeSettingsStore();
    a.set("terminal.fontSize", 20);
    expect(b.get("terminal.fontSize")).toBe(20);
  });

  it("set validates/clamps, updates the snapshot optimistically, writes through config_write, and broadcasts", async () => {
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = makeSettingsStore(undefined, bus, "settings");
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
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = makeSettingsStore(undefined, bus, "settings");
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
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } }, { failWrites: true });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const store = makeSettingsStore(undefined, fakeBus(), "settings");
    expect(() => store.set("terminal.fontSize", 18)).not.toThrow();
    expect(store.get("terminal.fontSize")).toBe(18);
    // The rejection is swallowed asynchronously; flush the microtask queue before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
  });

  it("resetAll clears the snapshot to defaults, invokes config_reset_all, and broadcasts each default", async () => {
    const backend = fakeConfigBackend({ values: { "appearance.theme": "sepia" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const bus = fakeBus();
    const store = makeSettingsStore(undefined, bus, "settings");
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
    const store = makeSettingsStore(undefined, fakeBus(), "main");
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
          values: { "appearance.theme": "white" },
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
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    await expect(openConfigFile()).resolves.toBeUndefined();
    expect(backend.calls).toContain("config_open_file");
  });

  it("PROPAGATES a rejection to the caller (unlike the fire-and-forget config_write path)", async () => {
    const backend = fakeOpenBackend({ failOpen: true });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    await expect(openConfigFile()).rejects.toThrow("opener denied");
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
        "appearance.theme": "sepia",
      },
    });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const store = makeSettingsStore();
    expect(store.get("update.autoCheck")).toBe(false);
    expect(store.get("terminal.fontSize")).toBe(14);
    expect(store.get("terminal.fontFamily")).toBe("Menlo");
    expect(store.get("terminal.scrollbackLines")).toBe(200_000);
    expect(store.get("appearance.theme")).toBe("sepia");
    // PRESENT-ONLY: keys absent from the file stay on their defaults.
    expect(store.get("terminal.cursorStyle")).toBe("underline");
  });

  it("an INVALID config-origin value falls back to the default and records a CLIENT warning", async () => {
    const backend = fakeConfigBackend({
      values: {
        "terminal.cursorBlink": "yes", // string where a boolean is required
        "update.checkFrequency": "hourly", // not an enum member
        "terminal.fontSize": "big", // string where a number is required
        "appearance.theme": "white",
      },
    });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    const store = makeSettingsStore();
    expect(store.get("terminal.cursorBlink")).toBe(false);
    expect(store.get("update.checkFrequency")).toBe("on-startup");
    expect(store.get("terminal.fontSize")).toBe(12);
    const client = getConfigWarnings().filter((w) => w.source === "client");
    expect(client).toHaveLength(3);
    expect(client.map((w) => w.message).join("\n")).toContain("terminal.cursorBlink");
    expect(client.map((w) => w.message).join("\n")).toContain("update.checkFrequency");
    expect(client.map((w) => w.message).join("\n")).toContain("terminal.fontSize");
  });

  it("stores the config path and renders backend warnings human-readably (source: file)", async () => {
    const backend = fakeConfigBackend({
      path: "/Users/me/.config/termixion/config.toml",
      values: { "appearance.theme": "white" },
      warnings: [
        { type: "SyntaxError", message: "expected `=` at line 3" },
        { type: "UnknownKey", key: "terminal.zoom" },
        { type: "InvalidValue", key: "terminal.cursorStyle", got: "sparkles", expected: "bar|block|underline" },
        { type: "OutOfRange", key: "terminal.fontSize", got: 99, clamped_to: 72 },
      ],
    });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(getConfigFilePath()).toBe("/Users/me/.config/termixion/config.toml");
    const file = getConfigWarnings().filter((w) => w.source === "file");
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
      hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage }),
    ).resolves.toBeUndefined();
    expect(makeSettingsStore().get("terminal.cursorStyle")).toBe("underline");
    expect(backend.writes()).toEqual([]); // no migration on the rejection path
    expect(storage.data.has("termixion.terminal.cursorStyle")).toBe(true);
    expect(getConfigFilePath()).toBeNull();
    expect(getConfigWarnings()).toEqual([]);
  });

  it("never throws when the invoke throws SYNCHRONOUSLY (no Tauri internals at all)", async () => {
    await expect(
      hydrateSettings({
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
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    expect(bus.listened.filter((e) => e === SETTINGS_CHANGED_EVENT)).toHaveLength(1);
  });
});

describe("live snapshot updates over the bus (trmx-80)", () => {
  it("keeps the snapshot current for other-window and config-file-watcher changes", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = makeSettingsStore();
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "terminal.fontSize", value: 18, source: "config-file" });
    expect(store.get("terminal.fontSize")).toBe(18);
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "terminal.cursorStyle", value: "bar", source: "settings" });
    expect(store.get("terminal.cursorStyle")).toBe("bar");
  });

  it("re-validates config-file-origin values: invalid → ignored + client warning", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = makeSettingsStore();
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "terminal.fontSize", value: 18, source: "config-file" });
    bus.fire(SETTINGS_CHANGED_EVENT, { key: "terminal.fontSize", value: "huge", source: "config-file" });
    expect(store.get("terminal.fontSize")).toBe(18); // the junk value never landed
    expect(
      getConfigWarnings().some((w) => w.source === "client" && w.message.includes("terminal.fontSize")),
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
    const backend = fakeConfigBackend({ values: { "appearance.theme": "sepia" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = makeSettingsStore();
    expect(store.get("appearance.theme")).toBe("sepia");
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "nihgt",
      source: "config-file",
    });
    expect(store.get("appearance.theme")).toBe("night"); // jsdom derivation → night
    expect(
      getConfigWarnings().some(
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
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const store = makeSettingsStore();
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
      values: { "appearance.theme": "white" },
      warnings: [{ type: "UnknownKey", key: "old.key" }],
    });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    expect(getConfigWarnings().map((w) => w.message).join()).toContain("old.key");
    bus.fire(CONFIG_WARNINGS_EVENT, [{ type: "UnknownKey", key: "new.key" }]);
    const messages = getConfigWarnings().map((w) => w.message).join();
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
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const seen: ConfigWarningItem[][] = [];
    const off = onConfigWarningsChanged((items) => void seen.push(items));
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
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    const seen: ConfigWarningItem[][] = [];
    onConfigWarningsChanged((items) => void seen.push(items));
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
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
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
      getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("appearance.theme"),
      ),
    ).toBe(true);
    // Re-authoring the SAME key replaces, never accumulates: still exactly one client warning.
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "wrogn-again",
      source: "config-file",
    });
    expect(getConfigWarnings().filter((w) => w.source === "client")).toHaveLength(1);
    // A LATER VALID value for the key is what clears it — the merged list goes empty.
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "mint",
      source: "config-file",
    });
    bus.fire(CONFIG_WARNINGS_EVENT, []);
    expect(getConfigWarnings()).toEqual([]);
  });

  it("hydration's client warning coexists with the file set and clears on a later valid value", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({
      values: { "appearance.theme": "hotdog-stand" },
      warnings: [{ type: "UnknownKey", key: "old.key" }],
    });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    // The merged list: FILE warnings first, then CLIENT warnings.
    const merged = getConfigWarnings();
    expect(merged.map((w) => w.source)).toEqual(["file", "client"]);
    expect(merged[0].message).toContain("old.key");
    expect(merged[1].message).toContain("appearance.theme");
    // The backend re-parses clean: the FILE set empties, the CLIENT warning survives.
    bus.fire(CONFIG_WARNINGS_EVENT, []);
    expect(getConfigWarnings().map((w) => w.source)).toEqual(["client"]);
    // The user fixes the theme: the valid value clears exactly that key's client warning.
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "mint",
      source: "config-file",
    });
    expect(getConfigWarnings()).toEqual([]);
  });

  it("notifies subscribers when a valid value clears a client warning (merged result changed)", async () => {
    const bus = fakeListenBus();
    const backend = fakeConfigBackend({ values: { "appearance.theme": "white" } });
    await hydrateSettings({ invoke: backend.invoke, bus, storage: fakeStorage() });
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "nihgt",
      source: "config-file",
    });
    const seen: ConfigWarningItem[][] = [];
    onConfigWarningsChanged((items) => void seen.push(items));
    bus.fire(SETTINGS_CHANGED_EVENT, {
      key: "appearance.theme",
      value: "mint",
      source: "config-file",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([]);
  });
});

describe("legacy localStorage migration (trmx-80 T3b)", () => {
  it("fresh install: no legacy keys → no migration writes (only the theme materialization)", async () => {
    const backend = fakeConfigBackend({ exists: false, values: {} });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(backend.writes().map((w) => w.key)).toEqual(["appearance.theme"]);
  });

  it("legacy install: parsed values land as config_write calls and the legacy keys are removed", async () => {
    const storage = fakeStorage({
      "termixion.update.autoCheck": "false",
      "termixion.terminal.cursorStyle": "block",
      "termixion.terminal.scrollbackLines": "999999", // clamped through the same per-key parse
      "termixion.appearance.theme": "sepia",
      "termixion.update.lastCheckAt": "2026-07-01T00:00:00Z", // NOT migrated, stays forever
    });
    const backend = fakeConfigBackend({ exists: false, values: {} });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage });
    const writes = backend.writes();
    expect(writes).toContainEqual({ key: "update.autoCheck", value: false });
    expect(writes).toContainEqual({ key: "terminal.cursorStyle", value: "block" });
    expect(writes).toContainEqual({ key: "terminal.scrollbackLines", value: 200_000 });
    expect(writes).toContainEqual({ key: "appearance.theme", value: "sepia" });
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
    const store = makeSettingsStore();
    expect(store.get("update.autoCheck")).toBe(false);
    expect(store.get("terminal.cursorStyle")).toBe("block");
    expect(store.get("appearance.theme")).toBe("sepia");
  });

  it("both present: the FILE wins — no migration, legacy keys untouched", async () => {
    const storage = fakeStorage({ "termixion.terminal.cursorStyle": "block" });
    const backend = fakeConfigBackend({
      exists: true,
      values: { "terminal.cursorStyle": "bar", "appearance.theme": "white" },
    });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage });
    expect(makeSettingsStore().get("terminal.cursorStyle")).toBe("bar");
    expect(backend.writes().some((w) => w.key === "terminal.cursorStyle")).toBe(false);
    expect(storage.data.has("termixion.terminal.cursorStyle")).toBe(true);
  });

  it("write failure: the legacy keys are NOT removed (retried next launch)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = fakeStorage({ "termixion.terminal.cursorStyle": "block" });
    const backend = fakeConfigBackend({ exists: false, values: {} }, { failWrites: true });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage });
    expect(storage.data.has("termixion.terminal.cursorStyle")).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe("theme materialization at hydration (trmx-80, superseding get()-time trmx-53)", () => {
  it("theme absent from the file (and not migrated): derives, seeds, and writes through", async () => {
    const backend = fakeConfigBackend({ exists: true, values: {} });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("appearance.theme")).toBe("night"); // jsdom derives night
    expect(backend.writes()).toContainEqual({ key: "appearance.theme", value: "night" });
  });

  it("theme present in the file: no materialization write", async () => {
    const backend = fakeConfigBackend({ exists: true, values: { "appearance.theme": "mint" } });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(makeSettingsStore().get("appearance.theme")).toBe("mint");
    expect(backend.writes().some((w) => w.key === "appearance.theme")).toBe(false);
  });

  it("a failing write-through keeps the derived value in the snapshot and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = fakeConfigBackend({ exists: true, values: {} }, { failWrites: true });
    await expect(
      hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() }),
    ).resolves.toBeUndefined();
    expect(makeSettingsStore().get("appearance.theme")).toBe("night");
    expect(warn).toHaveBeenCalled();
  });

  it("theme PRESENT but invalid: serves the derived default, warns, and NEVER writes the file", async () => {
    // Presence ≠ validity: a typo'd theme is the user's value to fix — materialization must not
    // clobber it with a derived write-through (that is only for the truly-absent key).
    const backend = fakeConfigBackend({
      exists: true,
      values: { "appearance.theme": "hotdog-stand" },
    });
    await hydrateSettings({ invoke: backend.invoke, bus: fakeListenBus(), storage: fakeStorage() });
    expect(backend.writes().some((w) => w.key === "appearance.theme")).toBe(false);
    // Reads serve the derived default for this session (jsdom derivation → night).
    expect(makeSettingsStore().get("appearance.theme")).toBe("night");
    expect(
      getConfigWarnings().some(
        (w) => w.source === "client" && w.message.includes("appearance.theme"),
      ),
    ).toBe(true);
  });
});
