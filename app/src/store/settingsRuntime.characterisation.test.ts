// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-253 (T3.1) — CHARACTERISATION of the settings store's two backends, written BEFORE the
// M8 runtime extraction so the refactor has a safety net that predates it.
//
// This is characterisation, not specification: every assertion below describes behaviour that
// already exists, so the file is GREEN on its first run. That is correct under R8, which requires
// RED for newly *specified* behaviour, not for pinning behaviour a refactor must preserve.
//
// The file was deliberately organised by BACKEND rather than by feature, because the whole point of
// trmx-253 is that there were two of them:
//
//   - "legacy storage backend"  — makeSettingsStore(storage): per-instance localStorage. TEST-ONLY
//     since trmx-80, shipped in production code anyway. T3.5 DELETED it, and its describe block
//     went with it — the deletion is the deliverable, so keeping characterisation of a backend
//     that no longer exists would have been the opposite of finishing the job.
//   - "snapshot backend"        — the production path: one shared, file-backed snapshot. It SURVIVED
//     the refactor, moving from module scope into createSettingsRuntime(); every assertion in its
//     describe block still holds, now reached through an explicitly constructed runtime handle
//     instead of the compat facade (T3.4). That is the safety net doing its job: the assertions
//     below are the ones written before the refactor, unchanged in meaning.
//
// The four axes are the ones named in the plan: get / set / subscribe / reset.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSettingsRuntime,
  SETTINGS_CHANGED_EVENT,
  SETTING_DEFAULTS,
  type KeyValueStore,
  type SettingsBus,
  type SettingsListenBus,
  type SettingsRuntime,
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

/** A listen-capable bus that hands the registered handlers back to the test. */
function listenBus(): SettingsListenBus & {
  handlers: Map<string, (payload: unknown) => void>;
  unlistened: string[];
} {
  const handlers = new Map<string, (payload: unknown) => void>();
  const unlistened: string[] = [];
  return {
    handlers,
    unlistened,
    listen: (event, handler) => {
      handlers.set(event, handler);
      return Promise.resolve(() => void unlistened.push(event));
    },
  };
}

// One runtime per test IS the isolation now: it owns all ten pieces of state, so there is nothing
// left to reset between cases — which is exactly why `__resetSettingsForTest` could be deleted.
let runtime: SettingsRuntime;
beforeEach(() => {
  runtime = createSettingsRuntime();
});

// ------------------------------------------------------------------------------------------------
// The snapshot backend — the production path. Everything here survived T3.2/T3.5 unchanged in
// meaning; only the handle it is reached through moved (module scope → runtime instance).
// ------------------------------------------------------------------------------------------------
describe("trmx-253 characterisation: snapshot backend (the production path)", () => {
  it("get: serves the registry default before hydration (a read never writes)", () => {
    const store = runtime.makeStore();
    expect(store.get("terminal.cursorStyle")).toBe(SETTING_DEFAULTS["terminal.cursorStyle"]);
    // trmx-53/80: the theme derives; materialization is hydrateSettings' job, not get()'s.
    expect(store.get("appearance.theme")).toBe(defaultThemeId());
  });

  it("get: every store built by ONE runtime shares that runtime's snapshot", () => {
    const a = runtime.makeStore();
    const b = runtime.makeStore();
    a.set("terminal.cursorStyle", "block");
    expect(b.get("terminal.cursorStyle")).toBe("block");
  });

  it("set: coerces, writes through config_write, and broadcasts", async () => {
    const invoke = vi.fn(() => Promise.resolve(undefined));
    const bus = recordingBus();
    await runtime.hydrate({ invoke, bus: listenBus(), storage: memoryStorage() });
    invoke.mockClear();
    const store = runtime.makeStore(bus, "main");
    store.set("terminal.scrollbackLines", 50_000);
    expect(store.get("terminal.scrollbackLines")).toBe(50_000);
    expect(invoke).toHaveBeenCalledWith("config_write", {
      key: "terminal.scrollbackLines",
      value: 50_000,
    });
    expect(bus.events).toEqual([
      {
        event: SETTINGS_CHANGED_EVENT,
        payload: { key: "terminal.scrollbackLines", value: 50_000, source: "main" },
      },
    ]);
  });

  it("set: STRICTLY REJECTS an unusable value — no snapshot, no write, no broadcast", async () => {
    const invoke = vi.fn(() => Promise.resolve(undefined));
    const bus = recordingBus();
    await runtime.hydrate({ invoke, bus: listenBus(), storage: memoryStorage() });
    invoke.mockClear();
    const store = runtime.makeStore(bus, "main");
    store.set("terminal.cursorStyle", "sparkles" as never);
    expect(store.get("terminal.cursorStyle")).toBe(SETTING_DEFAULTS["terminal.cursorStyle"]);
    expect(invoke).not.toHaveBeenCalled();
    expect(bus.events).toEqual([]);
  });

  it("set: clamps a number into the registry range before it reaches the snapshot", () => {
    const store = runtime.makeStore();
    store.set("terminal.fontSize", 999);
    expect(store.get("terminal.fontSize")).toBe(72);
  });

  it("subscribe: a settings:changed broadcast from another window updates the shared snapshot", async () => {
    const bus = listenBus();
    await runtime.hydrate({
      invoke: () => Promise.resolve(undefined),
      bus,
      storage: memoryStorage(),
    });
    bus.handlers.get(SETTINGS_CHANGED_EVENT)!({
      key: "terminal.cursorStyle",
      value: "block",
      source: "settings",
    });
    expect(runtime.makeStore().get("terminal.cursorStyle")).toBe("block");
  });

  it("subscribe: a config:warnings broadcast replaces the FILE ledger and notifies listeners", async () => {
    const bus = listenBus();
    await runtime.hydrate({
      invoke: () => Promise.resolve(undefined),
      bus,
      storage: memoryStorage(),
    });
    const seen: number[] = [];
    const off = runtime.onConfigWarningsChanged((items) => void seen.push(items.length));
    bus.handlers.get("config:warnings")!([{ type: "SyntaxError", message: "bad toml" }]);
    expect(runtime.getConfigWarnings()).toEqual([
      { source: "file", message: "Config file syntax error: bad toml" },
    ]);
    expect(seen).toEqual([1]);
    // The EMPTY set is how a fixed file clears the banner — it must reach subscribers too.
    bus.handlers.get("config:warnings")!([]);
    expect(runtime.getConfigWarnings()).toEqual([]);
    expect(seen).toEqual([1, 0]);
    off();
    bus.handlers.get("config:warnings")!([{ type: "SyntaxError", message: "again" }]);
    expect(seen).toEqual([1, 0]); // unsubscribed
  });

  it("reset: clears the snapshot, calls config_reset_all, and broadcasts every default", async () => {
    const invoke = vi.fn(() => Promise.resolve(undefined));
    const bus = recordingBus();
    await runtime.hydrate({ invoke, bus: listenBus(), storage: memoryStorage() });
    const store = runtime.makeStore(bus, "settings");
    store.set("terminal.cursorStyle", "block");
    invoke.mockClear();
    bus.events.length = 0;
    store.resetAll();
    expect(store.get("terminal.cursorStyle")).toBe(SETTING_DEFAULTS["terminal.cursorStyle"]);
    expect(invoke).toHaveBeenCalledWith("config_reset_all", undefined);
    const broadcast = new Map(
      bus.events.map((e) => {
        const p = e.payload as { key: string; value: unknown };
        return [p.key, p.value];
      }),
    );
    expect(broadcast.get("terminal.cursorStyle")).toBe(SETTING_DEFAULTS["terminal.cursorStyle"]);
    expect(broadcast.get("appearance.theme")).toBe(defaultThemeId());
  });

  it("hydrate: seeds from config_read, records the path, and renders file warnings", async () => {
    const bus = listenBus();
    await runtime.hydrate({
      invoke: (cmd) =>
        cmd === "config_read"
          ? Promise.resolve({
              exists: true,
              path: "/tmp/termixion.toml",
              values: { "terminal.cursorStyle": "block" },
              warnings: [{ type: "UnknownKey", key: "nope" }],
            })
          : Promise.resolve(undefined),
      bus,
      storage: memoryStorage(),
    });
    expect(runtime.makeStore().get("terminal.cursorStyle")).toBe("block");
    expect(runtime.getConfigWarnings()).toEqual([
      { source: "file", message: 'Unknown setting "nope" in the config file (ignored)' },
    ]);
  });

  it("hydrate: a write FAILURE records a per-key client warning (trmx-238 M14)", async () => {
    const bus = recordingBus();
    await runtime.hydrate({
      invoke: (cmd) =>
        cmd === "config_write"
          ? Promise.reject(new Error("read-only file"))
          : Promise.resolve({ exists: true, path: null, values: {}, warnings: [] }),
      bus: listenBus(),
      storage: memoryStorage(),
    });
    const store = runtime.makeStore(bus, "settings");
    store.set("terminal.cursorStyle", "block");
    await vi.waitFor(() => {
      // Containment, not equality: the theme materialization's own write failed first and is
      // ALSO in the ledger — one warning per key is the contract.
      expect(runtime.getConfigWarnings()).toContainEqual({
        source: "client",
        message: 'Could not save "terminal.cursorStyle": read-only file',
      });
    });
    // The optimistic snapshot value stands for the session even though the file refused it.
    expect(store.get("terminal.cursorStyle")).toBe("block");
  });
});
