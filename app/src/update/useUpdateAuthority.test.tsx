// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the MAIN window's authoritative update machine — owns the schedule (shouldAutoCheck +
// lastCheckAt), auto-download, the PendingUpdate handle, and serves other windows over the bus
// (update:state broadcasts, update:request-state snapshots, update:command execution). R8: these
// failing tests specify the authority before it exists.
//
// trmx-253 (T3.4): the settings stores come from `freshSettingsStore()` — one runtime per store,
// on the production (config-file) backend — instead of the deleted per-instance localStorage
// backend. Preferences are seeded with typed `set()` calls rather than raw storage strings.
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { makeFakeUpdateClient } from "./updateClient";
import { freshSettingsStore } from "../test/settingsRuntime";
import { useUpdateAuthority } from "./useUpdateAuthority";
import {
  UPDATE_COMMAND_EVENT,
  UPDATE_REQUEST_STATE_EVENT,
  UPDATE_STATE_EVENT,
  type UpdateStateBroadcast,
} from "./updateEvents";
import type { UpdateInfo } from "./updateState";
import type { EventBus } from "../ipc/eventBus";

const INFO: UpdateInfo = { version: "0.0.2", currentVersion: "0.0.1", notes: "notes" };
const NOW = () => new Date("2026-07-02T12:00:00Z");

// `update.lastCheckAt` is the ONE piece of state a settings runtime deliberately does NOT own: it
// is internal scheduler bookkeeping, not user configuration, so it never enters the config file and
// stays on the real localStorage forever (docs/config.md). That makes it a per-FILE global here —
// a fresh runtime does not isolate it — so seeding and asserting go through localStorage directly,
// and every test starts from a cleared key.
const LAST_CHECK_AT_KEY = "termixion.update.lastCheckAt";

beforeEach(() => {
  localStorage.clear();
});

/** One bus shared by "both windows": emit delivers synchronously to every listener. */
function fakeBus(): EventBus & { events: Array<{ event: string; payload: unknown }> } {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const events: Array<{ event: string; payload: unknown }> = [];
  return {
    events,
    emit(event, payload) {
      events.push({ event, payload });
      for (const h of [...(handlers.get(event) ?? [])]) h(payload);
    },
    listen(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return Promise.resolve(() => void set.delete(handler));
    },
  };
}

function stateBroadcasts(bus: ReturnType<typeof fakeBus>): UpdateStateBroadcast[] {
  return bus.events
    .filter((e) => e.event === UPDATE_STATE_EVENT)
    .map((e) => e.payload as UpdateStateBroadcast);
}

describe("useUpdateAuthority scheduling", () => {
  it("checks on startup by default (on-startup frequency) and records lastCheckAt", async () => {
    const settings = freshSettingsStore();
    const client = makeFakeUpdateClient({ update: null });
    const { result } = renderHook(() =>
      useUpdateAuthority({ client, settings, now: NOW }),
    );
    await waitFor(() => expect(result.current.state.status).toBe("up-to-date"));
    expect(localStorage.getItem(LAST_CHECK_AT_KEY)).toBe(NOW().toISOString());
  });

  it("does not check on startup when the master toggle is off", async () => {
    const settings = freshSettingsStore();
    settings.set("update.autoCheck", false);
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() => useUpdateAuthority({ client, settings, now: NOW }));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.state.status).toBe("idle");
  });

  it("does not check on startup under manual-only frequency", async () => {
    const settings = freshSettingsStore();
    settings.set("update.checkFrequency", "manual");
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() => useUpdateAuthority({ client, settings, now: NOW }));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.state.status).toBe("idle");
  });

  it("under daily frequency, skips a fresh lastCheckAt and checks a stale one", async () => {
    const fresh = freshSettingsStore();
    fresh.set("update.checkFrequency", "daily");
    fresh.set("update.autoDownload", false);
    // Both halves share the one localStorage key (see LAST_CHECK_AT_KEY above): seed it fresh,
    // mount, then re-seed it stale before the second mount. The first authority has already made
    // its at-most-once schedule decision by then, so re-seeding cannot disturb it.
    localStorage.setItem(
      LAST_CHECK_AT_KEY,
      new Date(NOW().getTime() - 2 * 3600_000).toISOString(),
    );
    const r1 = renderHook(() =>
      useUpdateAuthority({ client: makeFakeUpdateClient({ update: INFO }), settings: fresh, now: NOW }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(r1.result.current.state.status).toBe("idle");

    const stale = freshSettingsStore();
    stale.set("update.checkFrequency", "daily");
    stale.set("update.autoDownload", false);
    localStorage.setItem(
      LAST_CHECK_AT_KEY,
      new Date(NOW().getTime() - 25 * 3600_000).toISOString(),
    );
    const r2 = renderHook(() =>
      useUpdateAuthority({ client: makeFakeUpdateClient({ update: INFO }), settings: stale, now: NOW }),
    );
    await waitFor(() => expect(r2.result.current.state.status).toBe("available"));
  });

  it("manual checkNow also records lastCheckAt", async () => {
    const settings = freshSettingsStore();
    settings.set("update.checkFrequency", "manual");
    const client = makeFakeUpdateClient({ update: null });
    const { result } = renderHook(() => useUpdateAuthority({ client, settings, now: NOW }));
    await act(async () => {
      await result.current.checkNow();
    });
    expect(localStorage.getItem(LAST_CHECK_AT_KEY)).toBe(NOW().toISOString());
  });
});

describe("useUpdateAuthority auto-download", () => {
  it("flows available → downloading → ready automatically when auto-download is on (default)", async () => {
    const settings = freshSettingsStore();
    const client = makeFakeUpdateClient({
      update: INFO,
      progressTicks: [
        { downloaded: 0, total: 100 },
        { downloaded: 100, total: 100 },
      ],
    });
    const { result } = renderHook(() => useUpdateAuthority({ client, settings, now: NOW }));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
  });

  it("stays at available when auto-download is off", async () => {
    const settings = freshSettingsStore();
    settings.set("update.autoDownload", false);
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() => useUpdateAuthority({ client, settings, now: NOW }));
    await waitFor(() => expect(result.current.state.status).toBe("available"));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.state.status).toBe("available");
  });

  it("does not auto-download a version the user skipped", async () => {
    const settings = freshSettingsStore();
    settings.set("update.autoDownload", false);
    settings.set("update.checkFrequency", "manual");
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() => useUpdateAuthority({ client, settings, now: NOW }));
    await act(async () => {
      await result.current.checkNow();
    });
    act(() => result.current.skip());
    // The user turns auto-download back on, then a later check offers the same version again.
    settings.set("update.autoDownload", true);
    await act(async () => {
      await result.current.checkNow();
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.state.status).toBe("available"); // offered, but not downloaded
  });
});

describe("useUpdateAuthority bus protocol", () => {
  it("broadcasts update:state (tagged with its source) on every transition", async () => {
    const bus = fakeBus();
    const settings = freshSettingsStore();
    settings.set("update.autoDownload", false);
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() =>
      useUpdateAuthority({ client, settings, bus, now: NOW, source: "main" }),
    );
    await waitFor(() => expect(result.current.state.status).toBe("available"));
    const casts = stateBroadcasts(bus);
    expect(casts.length).toBeGreaterThan(0);
    expect(casts.every((c) => c.source === "main")).toBe(true);
    expect(casts.at(-1)!.state.status).toBe("available");
  });

  it("answers update:request-state with the current state", async () => {
    const bus = fakeBus();
    const settings = freshSettingsStore();
    settings.set("update.checkFrequency", "manual");
    const client = makeFakeUpdateClient({ update: null });
    renderHook(() => useUpdateAuthority({ client, settings, bus, now: NOW, source: "main" }));
    await waitFor(() =>
      expect(bus.events.some((e) => e.event === UPDATE_STATE_EVENT)).toBe(true),
    );
    bus.events.length = 0;
    act(() => {
      bus.emit(UPDATE_REQUEST_STATE_EVENT, { source: "settings" });
    });
    const casts = stateBroadcasts(bus);
    expect(casts).toHaveLength(1);
    expect(casts[0].state.status).toBe("idle");
  });

  it("executes update:command from another window and ignores its own echoes", async () => {
    const bus = fakeBus();
    const settings = freshSettingsStore();
    settings.set("update.checkFrequency", "manual");
    settings.set("update.autoDownload", false);
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() =>
      useUpdateAuthority({ client, settings, bus, now: NOW, source: "main" }),
    );
    await new Promise((r) => setTimeout(r, 5));
    act(() => {
      bus.emit(UPDATE_COMMAND_EVENT, { cmd: { type: "checkNow" }, source: "settings" });
    });
    await waitFor(() => expect(result.current.state.status).toBe("available"));

    // Its own source is ignored (no state change from a self-tagged command).
    act(() => {
      bus.emit(UPDATE_COMMAND_EVENT, { cmd: { type: "skip" }, source: "main" });
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(result.current.state.status).toBe("available");

    // Malformed payloads are ignored, never throw.
    act(() => {
      bus.emit(UPDATE_COMMAND_EVENT, { nonsense: true });
    });
    expect(result.current.state.status).toBe("available");

    // Value-strict guard: a truthy-string enabled must NOT be executed (step-9 review fix).
    act(() => {
      bus.emit(UPDATE_COMMAND_EVENT, {
        cmd: { type: "setAutoCheck", enabled: "false" },
        source: "settings",
      });
    });
    expect(result.current.state.autoCheckEnabled).toBe(true);
  });

  it("setAutoCheck via command persists through the settings store", async () => {
    const bus = fakeBus();
    const settings = freshSettingsStore();
    settings.set("update.checkFrequency", "manual");
    const client = makeFakeUpdateClient({ update: null });
    const { result } = renderHook(() =>
      useUpdateAuthority({ client, settings, bus, now: NOW, source: "main" }),
    );
    await new Promise((r) => setTimeout(r, 5));
    act(() => {
      bus.emit(UPDATE_COMMAND_EVENT, {
        cmd: { type: "setAutoCheck", enabled: false },
        source: "settings",
      });
    });
    await waitFor(() => expect(result.current.state.autoCheckEnabled).toBe(false));
    expect(settings.get("update.autoCheck")).toBe(false);
  });
});
