// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-253 (T3.2, test 5 of the plan's strategy table) — TWO RUNTIMES SHARE NOTHING.
//
// This is one of the two genuinely red-first files in trmx-253: before `createSettingsRuntime()`
// existed there was no second instance to compare against, because the state was module-global by
// construction. It is also the file that makes a PARTIAL extraction visible. Moving nine of the
// ten pieces into the closure looks exactly like moving ten from the outside — the API is
// identical, the characterisation suite still passes, and the one that stayed behind silently
// couples every runtime in the process. So there is a case per piece, named for the piece, and
// each is written so that SHARING THAT PIECE (and not merely sharing "some state") breaks it:
//
//   (1) snapshot                (2) configPath            (3) fileWarnings
//   (4) clientWarnings          (5) writeSeq              (6) writeFailedKeys
//   (7) configWarningsListeners (8) configInvoke          (9) busSubscribed
//  (10) busUnlistens
import { describe, expect, it, vi } from "vitest";
import {
  CONFIG_WARNINGS_EVENT,
  createSettingsRuntime,
  SETTINGS_CHANGED_EVENT,
  SETTING_DEFAULTS,
  type ConfigWarningItem,
  type KeyValueStore,
  type SettingsBus,
  type SettingsListenBus,
} from "./settingsStore";
import { defaultThemeId } from "../theme/defaultTheme";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function recordingBus(): SettingsBus & { events: Array<{ event: string; payload: unknown }> } {
  const events: Array<{ event: string; payload: unknown }> = [];
  return { events, emit: (event, payload) => void events.push({ event, payload }) };
}

/** A listen-capable bus that hands the registered handlers back, and records unlisten calls. */
function listenBus(): SettingsListenBus & {
  handlers: Map<string, (payload: unknown) => void>;
  listened: string[];
  unlistened: string[];
} {
  const handlers = new Map<string, (payload: unknown) => void>();
  const listened: string[] = [];
  const unlistened: string[] = [];
  return {
    handlers,
    listened,
    unlistened,
    listen: (event, handler) => {
      handlers.set(event, handler);
      listened.push(event);
      return Promise.resolve(() => void unlistened.push(event));
    },
  };
}

/** A `config_read` reply whose theme is already valid, so hydration materializes nothing. */
function configRead(over: Partial<{ exists: boolean; path: string | null; values: Record<string, unknown>; warnings: unknown[] }> = {}) {
  return {
    exists: true,
    path: null,
    warnings: [],
    ...over,
    values: { "appearance.theme": defaultThemeId(), ...(over.values ?? {}) },
  };
}

/** Let every already-scheduled microtask (the fire-and-forget write chain) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("trmx-253: two settings runtimes share no state (all ten pieces)", () => {
  it("(1) snapshot: a write in one runtime is invisible to the other", () => {
    const a = createSettingsRuntime();
    const b = createSettingsRuntime();
    a.makeStore().set("terminal.cursorStyle", "block");
    expect(a.makeStore().get("terminal.cursorStyle")).toBe("block");
    // The pre-M8 module snapshot made this the SAME map — every store in the process saw "block".
    expect(b.makeStore().get("terminal.cursorStyle")).toBe(
      SETTING_DEFAULTS["terminal.cursorStyle"],
    );
  });

  it("(2) configPath: each runtime learns only its OWN file path", async () => {
    const a = createSettingsRuntime();
    const b = createSettingsRuntime();
    const c = createSettingsRuntime();
    await a.hydrate({
      invoke: () => Promise.resolve(configRead({ path: "/a/termixion.toml" })),
      bus: listenBus(),
      storage: memoryStorage(),
    });
    await b.hydrate({
      invoke: () => Promise.resolve(configRead({ path: "/b/termixion.toml" })),
      bus: listenBus(),
      storage: memoryStorage(),
    });
    expect(a.getConfigFilePath()).toBe("/a/termixion.toml");
    expect(b.getConfigFilePath()).toBe("/b/termixion.toml");
    // A never-hydrated runtime keeps the pre-hydration null even while two others are hydrated.
    expect(c.getConfigFilePath()).toBeNull();
  });

  it("(3) fileWarnings: a config:warnings broadcast lands in ONE runtime's file ledger", async () => {
    const a = createSettingsRuntime();
    const b = createSettingsRuntime();
    const busA = listenBus();
    const busB = listenBus();
    const invoke = () => Promise.resolve(configRead());
    await a.hydrate({ invoke, bus: busA, storage: memoryStorage() });
    await b.hydrate({ invoke, bus: busB, storage: memoryStorage() });

    busA.handlers.get(CONFIG_WARNINGS_EVENT)!([{ type: "SyntaxError", message: "bad toml" }]);
    expect(a.getConfigWarnings()).toEqual([
      { source: "file", message: "Config file syntax error: bad toml" },
    ]);
    expect(b.getConfigWarnings()).toEqual([]);
  });

  it("(4) clientWarnings: a valid write in one runtime cannot clear the other's warning", async () => {
    const a = createSettingsRuntime();
    const b = createSettingsRuntime();
    // A's file carries an invalid cursor style, so A authors a per-key CLIENT warning for it.
    await a.hydrate({
      invoke: () => Promise.resolve(configRead({ values: { "terminal.cursorStyle": "sparkles" } })),
      bus: listenBus(),
      storage: memoryStorage(),
    });
    await b.hydrate({ invoke: () => Promise.resolve(configRead()), bus: listenBus(), storage: memoryStorage() });
    expect(a.getConfigWarnings()).toHaveLength(1);

    // A VALID value for the same key supersedes that key's client warning — in the runtime that
    // wrote it, and only there. With one shared ledger this cleared A's warning too.
    b.makeStore().set("terminal.cursorStyle", "block");
    await settle();
    expect(b.getConfigWarnings()).toEqual([]);
    expect(a.getConfigWarnings()).toEqual([
      {
        source: "client",
        message: 'Invalid value for "terminal.cursorStyle" in the config file; using the default.',
      },
    ]);
  });

  it("(5) writeSeq: write tickets are per runtime, so a sibling's write cannot supersede mine", async () => {
    // The M14 ticket rule: a rejection authors a warning only while it is still the NEWEST write
    // for its key. With ONE shared ticket map, B's write to the same key would bump the counter and
    // silently demote A's in-flight write to "superseded" — A's rejection would then be swallowed
    // and the user would never learn their change did not land.
    let rejectA: (err: Error) => void = () => {};
    const a = createSettingsRuntime({
      invoke: (cmd) =>
        cmd === "config_write"
          ? new Promise((_resolve, reject) => {
              rejectA = reject;
            })
          : Promise.resolve(undefined),
    });
    const b = createSettingsRuntime({ invoke: () => Promise.resolve(undefined) });

    a.makeStore().set("terminal.fontSize", 14); // A's ticket 1 for this key, still in flight
    b.makeStore().set("terminal.fontSize", 20); // would be ticket 2 if the map were shared
    await settle();
    rejectA(new Error("read-only file"));
    await settle();

    expect(a.getConfigWarnings()).toEqual([
      { source: "client", message: 'Could not save "terminal.fontSize": read-only file' },
    ]);
    expect(b.getConfigWarnings()).toEqual([]);
  });

  it("(6) writeFailedKeys: one runtime's write FAILURE cannot make another's success over-clear", async () => {
    // A successful write clears only a WRITE-failure warning, never a validation warning — that is
    // what the writeFailedKeys set is for ("a successful write clears only its own kind"). The
    // probe: give B a VALIDATION warning for a key and then let B write that key successfully
    // through the migration path (which persists directly, without set()'s synchronous clear). B
    // must keep its warning. If the set were shared, A's earlier FAILURE on the same key would have
    // put it in there, B's success would find it, and B's validation warning would vanish.
    const a = createSettingsRuntime({
      invoke: (cmd) =>
        cmd === "config_write" ? Promise.reject(new Error("read-only")) : Promise.resolve(undefined),
    });
    a.makeStore().set("terminal.fontSize", 14);
    await settle();
    expect(a.getConfigWarnings()).toHaveLength(1); // A's write-failure warning, key in writeFailedKeys

    const b = createSettingsRuntime();
    await b.hydrate({
      // exists:false ⇒ the T3b legacy migration runs; the file's own fontSize is junk ⇒ B authors a
      // VALIDATION warning for exactly the key A failed on.
      invoke: (cmd) =>
        cmd === "config_read"
          ? Promise.resolve(configRead({ exists: false, values: { "terminal.fontSize": "abc" } }))
          : Promise.resolve(undefined),
      bus: listenBus(),
      storage: memoryStorage({ "termixion.terminal.fontSize": "18" }),
    });
    await settle();
    expect(b.getConfigWarnings()).toEqual([
      {
        source: "client",
        message: 'Invalid value for "terminal.fontSize" in the config file; using the default.',
      },
    ]);
  });

  it("(7) configWarningsListeners: subscribers belong to the runtime they subscribed on", async () => {
    const a = createSettingsRuntime();
    const b = createSettingsRuntime();
    const busA = listenBus();
    const busB = listenBus();
    const invoke = () => Promise.resolve(configRead());
    await a.hydrate({ invoke, bus: busA, storage: memoryStorage() });
    await b.hydrate({ invoke, bus: busB, storage: memoryStorage() });

    const seenA: number[] = [];
    const seenB: number[] = [];
    const offA = a.onConfigWarningsChanged((items) => void seenA.push(items.length));
    b.onConfigWarningsChanged((items) => void seenB.push(items.length));

    busB.handlers.get(CONFIG_WARNINGS_EVENT)!([{ type: "SyntaxError", message: "bad toml" }]);
    expect(seenB).toEqual([1]);
    expect(seenA).toEqual([]); // a shared listener set would have notified A's subscriber too

    // Unsubscribing on A must not touch B's subscriber (one shared Set would clear both).
    offA();
    busB.handlers.get(CONFIG_WARNINGS_EVENT)!([]);
    expect(seenB).toEqual([1, 0]);
  });

  it("(8) configInvoke: each runtime writes down its OWN channel", async () => {
    const invokeA = vi.fn(() => Promise.resolve(undefined));
    const invokeB = vi.fn(() => Promise.resolve(undefined));
    const a = createSettingsRuntime();
    const b = createSettingsRuntime();
    // Hydration installs the channel; B hydrates LAST, which under one module-level `configInvoke`
    // was enough to redirect every store in the process — including A's — onto invokeB.
    await a.hydrate({ invoke: invokeA, bus: listenBus(), storage: memoryStorage() });
    await b.hydrate({ invoke: invokeB, bus: listenBus(), storage: memoryStorage() });
    invokeA.mockClear();
    invokeB.mockClear();

    a.makeStore().set("terminal.fontSize", 14);
    await settle();
    expect(invokeA).toHaveBeenCalledWith("config_write", { key: "terminal.fontSize", value: 14 });
    expect(invokeB).not.toHaveBeenCalled();

    // The non-value commands ride the same per-runtime channel.
    void a.openConfigFile();
    void b.getLogDir();
    await settle();
    expect(invokeA).toHaveBeenCalledWith("config_open_file", undefined);
    expect(invokeB).toHaveBeenCalledWith("log_dir", undefined);
    expect(invokeB).not.toHaveBeenCalledWith("config_open_file", undefined);
  });

  it("(9) busSubscribed: every runtime subscribes to its own bus, exactly once", async () => {
    const a = createSettingsRuntime();
    const b = createSettingsRuntime();
    const busA = listenBus();
    const busB = listenBus();
    const invoke = () => Promise.resolve(configRead());
    await a.hydrate({ invoke, bus: busA, storage: memoryStorage() });
    // The second runtime MUST still subscribe — one shared `busSubscribed` flag left B deaf to
    // settings:changed and config:warnings entirely.
    await b.hydrate({ invoke, bus: busB, storage: memoryStorage() });
    expect(busA.listened).toEqual([SETTINGS_CHANGED_EVENT, CONFIG_WARNINGS_EVENT]);
    expect(busB.listened).toEqual([SETTINGS_CHANGED_EVENT, CONFIG_WARNINGS_EVENT]);

    // …and only once per runtime: re-hydrating does not double-subscribe.
    await a.hydrate({ invoke, bus: busA, storage: memoryStorage() });
    expect(busA.listened).toHaveLength(2);

    // Live proof the subscriptions are wired to the right snapshots.
    busA.handlers.get(SETTINGS_CHANGED_EVENT)!({
      key: "terminal.cursorStyle",
      value: "block",
      source: "other-window",
    });
    expect(a.makeStore().get("terminal.cursorStyle")).toBe("block");
    expect(b.makeStore().get("terminal.cursorStyle")).toBe(
      SETTING_DEFAULTS["terminal.cursorStyle"],
    );
  });

  it("(10) busUnlistens + dispose: tearing one runtime down leaves the other fully alive", async () => {
    const a = createSettingsRuntime();
    const b = createSettingsRuntime();
    const busA = listenBus();
    const busB = listenBus();
    const invoke = () => Promise.resolve(configRead({ path: "/b/termixion.toml" }));
    await a.hydrate({ invoke, bus: busA, storage: memoryStorage() });
    await b.hydrate({ invoke, bus: busB, storage: memoryStorage() });
    b.makeStore().set("terminal.cursorStyle", "block");
    const seenB: ConfigWarningItem[][] = [];
    b.onConfigWarningsChanged((items) => void seenB.push(items));

    a.dispose();
    expect(busA.unlistened).toEqual([SETTINGS_CHANGED_EVENT, CONFIG_WARNINGS_EVENT]);
    // A shared unlisten list would have torn B's subscriptions down with A's.
    expect(busB.unlistened).toEqual([]);

    // Everything B owns survives A's teardown: snapshot, path, subscribers, bus wiring.
    expect(b.makeStore().get("terminal.cursorStyle")).toBe("block");
    expect(b.getConfigFilePath()).toBe("/b/termixion.toml");
    busB.handlers.get(CONFIG_WARNINGS_EVENT)!([{ type: "SyntaxError", message: "bad toml" }]);
    expect(seenB).toEqual([[{ source: "file", message: "Config file syntax error: bad toml" }]]);

    // And A really is back to a pre-hydration state (dispose leaves the handle usable).
    expect(a.getConfigFilePath()).toBeNull();
    expect(a.getConfigWarnings()).toEqual([]);
    expect(a.makeStore().get("terminal.cursorStyle")).toBe(
      SETTING_DEFAULTS["terminal.cursorStyle"],
    );
  });

  it("broadcasts stay on the bus the runtime's store was built with", async () => {
    const busA = recordingBus();
    const busB = recordingBus();
    const a = createSettingsRuntime({ invoke: () => Promise.resolve(undefined) });
    const b = createSettingsRuntime({ invoke: () => Promise.resolve(undefined) });
    a.makeStore(busA, "main").set("terminal.cursorBlink", true);
    await settle();
    expect(busA.events).toEqual([
      {
        event: SETTINGS_CHANGED_EVENT,
        payload: { key: "terminal.cursorBlink", value: true, source: "main" },
      },
    ]);
    expect(busB.events).toEqual([]);
    expect(b.makeStore().get("terminal.cursorBlink")).toBe(
      SETTING_DEFAULTS["terminal.cursorBlink"],
    );
  });
});
