// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the settings window's update PROJECTION — it never checks/downloads itself; it converges
// on the authority's broadcast snapshots (late subscribers included) and forwards manual actions as
// update:command. R8: failing tests first, including the review's late-open and mirrored-Download
// scenarios.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeFakeUpdateClient } from "./updateClient";
import { makeSettingsStore, type KeyValueStore } from "../settings/settingsStore";
import { useUpdateAuthority } from "./useUpdateAuthority";
import { useUpdateMirror } from "./useUpdateMirror";
import {
  UPDATE_COMMAND_EVENT,
  UPDATE_REQUEST_STATE_EVENT,
  UPDATE_STATE_EVENT,
  type UpdateCommandEnvelope,
} from "./updateEvents";
import { initialUpdateState, type UpdateInfo, type UpdateState } from "./updateState";
import type { EventBus } from "../ipc/eventBus";

const INFO: UpdateInfo = { version: "0.0.2", currentVersion: "0.0.1", notes: "notes" };

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

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

const rejectingBus: EventBus = {
  emit: () => {},
  listen: () => Promise.reject(new Error("no tauri runtime")),
};

function snapshotOf(status: UpdateState["status"]): UpdateState {
  const base = initialUpdateState(true);
  if (status === "idle") return base;
  if (status === "available") return { ...base, status, updateInfo: INFO };
  if (status === "downloading")
    return { ...base, status, updateInfo: INFO, progress: { downloaded: 10, total: 100 } };
  if (status === "ready") return { ...base, status, updateInfo: INFO };
  return { ...base, status };
}

describe("useUpdateMirror", () => {
  it("requests a snapshot on mount and converges when opened late — available / downloading / ready", async () => {
    for (const status of ["available", "downloading", "ready"] as const) {
      const bus = fakeBus();
      // Simulate the authority: reply to a snapshot request with the current (pre-existing) state.
      await bus.listen(UPDATE_REQUEST_STATE_EVENT, () => {
        bus.emit(UPDATE_STATE_EVENT, { state: snapshotOf(status), source: "main" });
      });
      const settings = makeSettingsStore(fakeStorage());
      const { result } = renderHook(() => useUpdateMirror({ bus, settings }));
      await waitFor(() => expect(result.current.update.state.status).toBe(status));
      expect(result.current.connected).toBe(true);
    }
  });

  it("applies later authority broadcasts as they arrive", async () => {
    const bus = fakeBus();
    const settings = makeSettingsStore(fakeStorage());
    const { result } = renderHook(() => useUpdateMirror({ bus, settings }));
    await waitFor(() => expect(result.current.connected).toBe(true));
    act(() => {
      bus.emit(UPDATE_STATE_EVENT, { state: snapshotOf("downloading"), source: "main" });
    });
    expect(result.current.update.state.status).toBe("downloading");
  });

  it("ignores broadcasts tagged with its own source and malformed payloads", async () => {
    const bus = fakeBus();
    const settings = makeSettingsStore(fakeStorage());
    const { result } = renderHook(() => useUpdateMirror({ bus, settings, source: "settings" }));
    await waitFor(() => expect(result.current.connected).toBe(true));
    act(() => {
      bus.emit(UPDATE_STATE_EVENT, { state: snapshotOf("ready"), source: "settings" });
      bus.emit(UPDATE_STATE_EVENT, { garbage: true });
    });
    expect(result.current.update.state.status).toBe("idle");
  });

  it("forwards manual actions as update:command — Download works from a mirrored available state", async () => {
    const bus = fakeBus();
    await bus.listen(UPDATE_REQUEST_STATE_EVENT, () => {
      bus.emit(UPDATE_STATE_EVENT, { state: snapshotOf("available"), source: "main" });
    });
    const settings = makeSettingsStore(fakeStorage());
    const { result } = renderHook(() => useUpdateMirror({ bus, settings, source: "settings" }));
    await waitFor(() => expect(result.current.update.state.status).toBe("available"));

    await act(async () => {
      await result.current.update.download();
    });
    const commands = bus.events
      .filter((e) => e.event === UPDATE_COMMAND_EVENT)
      .map((e) => e.payload as UpdateCommandEnvelope);
    expect(commands).toContainEqual({ cmd: { type: "download" }, source: "settings" });
  });

  it("reports disconnected (fallback signal) when the bus has no runtime", async () => {
    const settings = makeSettingsStore(fakeStorage());
    const { result } = renderHook(() => useUpdateMirror({ bus: rejectingBus, settings }));
    await waitFor(() => expect(result.current.connected).toBe(false));
    expect(result.current.update.state.status).toBe("idle");
  });

  it("end-to-end with a real authority on the same bus: mirror's Check Now drives the authority and the mirror converges", async () => {
    const bus = fakeBus();
    const settings = makeSettingsStore(
      fakeStorage({
        "termixion.update.checkFrequency": "manual",
        "termixion.update.autoDownload": "false",
      }),
    );
    const client = makeFakeUpdateClient({ update: INFO });
    renderHook(() =>
      useUpdateAuthority({
        client,
        settings,
        bus,
        now: () => new Date("2026-07-02T12:00:00Z"),
        source: "main",
      }),
    );
    const mirror = renderHook(() => useUpdateMirror({ bus, settings, source: "settings" }));
    await waitFor(() => expect(mirror.result.current.connected).toBe(true));

    await act(async () => {
      await mirror.result.current.update.checkNow();
    });
    await waitFor(() =>
      expect(mirror.result.current.update.state.status).toBe("available"),
    );
    expect(mirror.result.current.update.state.updateInfo).toEqual(INFO);
  });
});
