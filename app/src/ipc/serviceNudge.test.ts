// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
// trmx-224: the nudge observation contract — the registration-completion drain and the
// teardown-before-resolve guarantee (the frozen-plan T7 RED tests).

import { describe, expect, it, vi } from "vitest";

import { SERVICE_OPEN_PATHS_EVENT } from "./backend";
import type { EventBus } from "./eventBus";
import { makeObserveServiceNudge } from "./serviceNudge";

/** An EventBus fake whose listen-registration promise resolves under test control. */
function makeControlledBus() {
  let handler: ((payload: unknown) => void) | undefined;
  let resolveRegistration!: (u: () => void) => void;
  const unlisten = vi.fn();
  const bus: EventBus = {
    emit: () => {},
    listen: (event, h) => {
      expect(event).toBe(SERVICE_OPEN_PATHS_EVENT);
      handler = h;
      return new Promise((resolve) => {
        resolveRegistration = resolve;
      });
    },
  };
  return {
    bus,
    unlisten,
    fireEvent: (payload: unknown = undefined) => handler?.(payload),
    resolveRegistration: () => resolveRegistration(unlisten),
  };
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("makeObserveServiceNudge (trmx-224)", () => {
  it("fires one registration-completion nudge — queued paths need no event to be drained", async () => {
    // Paths can sit in the backend queue with their nudge lost (emitted before this
    // listener registered). Registration completion alone must trigger a drain.
    const { bus, resolveRegistration } = makeControlledBus();
    const onNudge = vi.fn();
    makeObserveServiceNudge(bus)(onNudge);
    expect(onNudge).not.toHaveBeenCalled();
    resolveRegistration();
    await flushMicrotasks();
    expect(onNudge).toHaveBeenCalledTimes(1);
  });

  it("relays events to the handler while live", async () => {
    const { bus, resolveRegistration, fireEvent } = makeControlledBus();
    const onNudge = vi.fn();
    makeObserveServiceNudge(bus)(onNudge);
    resolveRegistration();
    await flushMicrotasks();
    fireEvent();
    fireEvent();
    expect(onNudge).toHaveBeenCalledTimes(3); // 1 registration drain + 2 events
  });

  it("teardown before registration resolves unlistens the late subscription and stays silent", async () => {
    // StrictMode replay: cleanup runs before the async listen resolves. The late
    // registration must be unlistened (no leak) and must NOT fire the registration drain
    // into a dead handler.
    const { bus, resolveRegistration, unlisten, fireEvent } = makeControlledBus();
    const onNudge = vi.fn();
    const stop = makeObserveServiceNudge(bus)(onNudge);
    stop();
    resolveRegistration();
    await flushMicrotasks();
    expect(unlisten).toHaveBeenCalledTimes(1);
    fireEvent();
    expect(onNudge).not.toHaveBeenCalled();
  });

  it("teardown after registration unlistens and silences later events", async () => {
    const { bus, resolveRegistration, unlisten, fireEvent } = makeControlledBus();
    const onNudge = vi.fn();
    const stop = makeObserveServiceNudge(bus)(onNudge);
    resolveRegistration();
    await flushMicrotasks();
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    fireEvent();
    expect(onNudge).toHaveBeenCalledTimes(1); // only the registration drain, nothing after stop
  });
});
