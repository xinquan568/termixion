// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the persisted-settings registry. One enumerable place for every user-visible setting —
// defaults, storage keys, parsing — so "Reset all settings" can restore *everything* and future
// keys can't silently escape it (R8: these are the failing tests written first).
import { describe, it, expect, vi } from "vitest";
import {
  makeSettingsStore,
  SETTING_KEYS,
  SETTING_DEFAULTS,
  type KeyValueStore,
  type SettingsBus,
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

describe("settingsStore defaults", () => {
  it("serves the registry defaults (trmx-51; blink off since trmx-55) when nothing is persisted", () => {
    const store = makeSettingsStore(fakeStorage());
    expect(store.get("update.autoCheck")).toBe(true);
    expect(store.get("update.checkFrequency")).toBe("on-startup");
    expect(store.get("update.autoDownload")).toBe(true);
    expect(store.get("terminal.cursorStyle")).toBe("underline");
    expect(store.get("terminal.cursorBlink")).toBe(false);
  });

  it("round-trips every setting", () => {
    const store = makeSettingsStore(fakeStorage());
    store.set("update.autoCheck", false);
    store.set("update.checkFrequency", "weekly");
    store.set("update.autoDownload", false);
    store.set("terminal.cursorStyle", "bar");
    store.set("terminal.cursorBlink", true);
    expect(store.get("update.autoCheck")).toBe(false);
    expect(store.get("update.checkFrequency")).toBe("weekly");
    expect(store.get("update.autoDownload")).toBe(false);
    expect(store.get("terminal.cursorStyle")).toBe("bar");
    expect(store.get("terminal.cursorBlink")).toBe(true);
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

  it("degrades to defaults when storage is absent or throwing", () => {
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
    const none = makeSettingsStore(undefined);
    expect(none.get("update.autoDownload")).toBe(true);
  });
});

describe("settingsStore broadcasting", () => {
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

describe("resetAllSettings", () => {
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
    // The cursor settings the live terminal consumes are among them.
    expect(emittedKeys).toContain("terminal.cursorStyle");
    expect(emittedKeys).toContain("terminal.cursorBlink");
  });
});

describe("lastCheckAt bookkeeping", () => {
  it("round-trips and defaults to null", () => {
    const store = makeSettingsStore(fakeStorage());
    expect(store.loadLastCheckAt()).toBeNull();
    store.saveLastCheckAt("2026-07-02T01:02:03Z");
    expect(store.loadLastCheckAt()).toBe("2026-07-02T01:02:03Z");
  });
});

describe("registry shape", () => {
  it("exposes the enumerable user-visible key set trmx-51 ships (+ appearance.theme since trmx-53)", () => {
    expect([...SETTING_KEYS].sort()).toEqual(
      [
        "update.autoCheck",
        "update.checkFrequency",
        "update.autoDownload",
        "terminal.cursorStyle",
        "terminal.cursorBlink",
        "appearance.theme",
      ].sort(),
    );
  });

  it("never uses vi timers or real Tauri — pure seams only", () => {
    // (documentation-by-test: makeSettingsStore takes only injected seams)
    expect(vi.isFakeTimers()).toBe(false);
  });
});

// trmx-53: appearance.theme — the registry's one DYNAMIC default. With no persisted value the
// first-run theme derives from the OS appearance (dark → night, light → white; jsdom has no
// matchMedia → night) and MATERIALIZES: the derived value is written back so the OS is consulted
// only once ("derive once, then persist"). Reset removes the key, so a post-reset read behaves
// like a fresh first run (plan D1), and the reset broadcast carries the derived value.
describe("appearance.theme (trmx-53)", () => {
  const THEME_STORAGE_KEY = "termixion.appearance.theme";

  it("derives the first-run default (jsdom: no matchMedia → night) and materializes it", () => {
    const storage = fakeStorage();
    const store = makeSettingsStore(storage);
    expect(store.get("appearance.theme")).toBe("night");
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("night");
  });

  it("round-trips an explicit choice", () => {
    const store = makeSettingsStore(fakeStorage());
    store.set("appearance.theme", "sepia");
    expect(store.get("appearance.theme")).toBe("sepia");
  });

  it("treats a garbage persisted value as the derived default (and does not overwrite it)", () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: "hotdog-stand" });
    const store = makeSettingsStore(storage);
    expect(store.get("appearance.theme")).toBe("night");
    // Parsing junk is a read-time fallback, not a repair: the raw value stays until a set().
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("hotdog-stand");
  });

  it("degrades to the derived default when storage is absent or throwing", () => {
    expect(makeSettingsStore(undefined).get("appearance.theme")).toBe("night");
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
    expect(makeSettingsStore(throwing).get("appearance.theme")).toBe("night");
  });

  it("resetAll removes the key and broadcasts the derived default", () => {
    const storage = fakeStorage();
    const bus = fakeBus();
    const store = makeSettingsStore(storage, bus, "test");
    store.set("appearance.theme", "mint");
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("mint");
    store.resetAll();
    expect(storage.data.has(THEME_STORAGE_KEY)).toBe(false);
    const themeEvents = bus.events.filter(
      (e) => (e.payload as { key?: string }).key === "appearance.theme",
    );
    // set() + resetAll() each broadcast; the reset broadcast carries the derived default.
    expect(themeEvents.at(-1)?.payload).toMatchObject({ key: "appearance.theme", value: "night" });
  });
});
