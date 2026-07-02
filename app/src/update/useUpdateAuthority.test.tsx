// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the MAIN window's authoritative update machine — owns the schedule (shouldAutoCheck +
// lastCheckAt), auto-download, the PendingUpdate handle, and serves other windows over the bus
// (update:state broadcasts, update:request-state snapshots, update:command execution). R8: these
// failing tests specify the authority before it exists.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeFakeUpdateClient } from "./updateClient";
import { makeSettingsStore, type KeyValueStore } from "../settings/settingsStore";
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

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

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
    const storage = fakeStorage();
    const settings = makeSettingsStore(storage);
    const client = makeFakeUpdateClient({ update: null });
    const { result } = renderHook(() =>
      useUpdateAuthority({ client, settings, now: NOW }),
    );
    await waitFor(() => expect(result.current.state.status).toBe("up-to-date"));
    expect(settings.loadLastCheckAt()).toBe(NOW().toISOString());
  });

  it("does not check on startup when the master toggle is off", async () => {
    const settings = makeSettingsStore(
      fakeStorage({ "termixion.update.autoCheck": "false" }),
    );
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() => useUpdateAuthority({ client, settings, now: NOW }));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.state.status).toBe("idle");
  });

  it("does not check on startup under manual-only frequency", async () => {
    const settings = makeSettingsStore(
      fakeStorage({ "termixion.update.checkFrequency": "manual" }),
    );
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() => useUpdateAuthority({ client, settings, now: NOW }));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.state.status).toBe("idle");
  });

  it("under daily frequency, skips a fresh lastCheckAt and checks a stale one", async () => {
    const fresh = makeSettingsStore(
      fakeStorage({
        "termixion.update.checkFrequency": "daily",
        "termixion.update.lastCheckAt": new Date(NOW().getTime() - 2 * 3600_000).toISOString(),
        "termixion.update.autoDownload": "false",
      }),
    );
    const r1 = renderHook(() =>
      useUpdateAuthority({ client: makeFakeUpdateClient({ update: INFO }), settings: fresh, now: NOW }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(r1.result.current.state.status).toBe("idle");

    const stale = makeSettingsStore(
      fakeStorage({
        "termixion.update.checkFrequency": "daily",
        "termixion.update.lastCheckAt": new Date(NOW().getTime() - 25 * 3600_000).toISOString(),
        "termixion.update.autoDownload": "false",
      }),
    );
    const r2 = renderHook(() =>
      useUpdateAuthority({ client: makeFakeUpdateClient({ update: INFO }), settings: stale, now: NOW }),
    );
    await waitFor(() => expect(r2.result.current.state.status).toBe("available"));
  });

  it("manual checkNow also records lastCheckAt", async () => {
    const settings = makeSettingsStore(
      fakeStorage({ "termixion.update.checkFrequency": "manual" }),
    );
    const client = makeFakeUpdateClient({ update: null });
    const { result } = renderHook(() => useUpdateAuthority({ client, settings, now: NOW }));
    await act(async () => {
      await result.current.checkNow();
    });
    expect(settings.loadLastCheckAt()).toBe(NOW().toISOString());
  });
});

describe("useUpdateAuthority auto-download", () => {
  it("flows available → downloading → ready automatically when auto-download is on (default)", async () => {
    const settings = makeSettingsStore(fakeStorage());
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
    const settings = makeSettingsStore(
      fakeStorage({ "termixion.update.autoDownload": "false" }),
    );
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() => useUpdateAuthority({ client, settings, now: NOW }));
    await waitFor(() => expect(result.current.state.status).toBe("available"));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.state.status).toBe("available");
  });

  it("does not auto-download a version the user skipped", async () => {
    const settings = makeSettingsStore(
      fakeStorage({
        "termixion.update.autoDownload": "false",
        "termixion.update.checkFrequency": "manual",
      }),
    );
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
    const settings = makeSettingsStore(
      fakeStorage({ "termixion.update.autoDownload": "false" }),
    );
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
    const settings = makeSettingsStore(
      fakeStorage({ "termixion.update.checkFrequency": "manual" }),
    );
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
    const settings = makeSettingsStore(
      fakeStorage({
        "termixion.update.checkFrequency": "manual",
        "termixion.update.autoDownload": "false",
      }),
    );
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

    // A malformed payload is ignored, never throws.
    act(() => {
      bus.emit(UPDATE_COMMAND_EVENT, { nonsense: true });
    });
    expect(result.current.state.status).toBe("available");
  });

  it("setAutoCheck via command persists through the settings store", async () => {
    const bus = fakeBus();
    const storage = fakeStorage({ "termixion.update.checkFrequency": "manual" });
    const settings = makeSettingsStore(storage);
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
