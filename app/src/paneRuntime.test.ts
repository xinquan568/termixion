// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-248: the pane teardown contract. #248 asks for exactly this — "create/dispose idempotence and
// that dispose clears timers" — because teardown is the behaviour the fifteen parallel maps kept
// getting wrong: every new map needed a matching delete line, and a forgotten `clearTimeout` leaves a
// timer to fire into a closed pane.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPaneRuntimes, type PaneRuntime } from "./paneRuntime";
import type { CwdStore } from "./terminal/osc7";

const fakeCwd = () => ({}) as CwdStore;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("paneRuntime (trmx-248)", () => {
  it("dispose clears BOTH pending timers, so neither fires into a closed pane", () => {
    const runtimes = createPaneRuntimes();
    const runtime = runtimes.ensure(1, fakeCwd());
    const activity = vi.fn();
    const flash = vi.fn();
    runtime.activityTimer = setTimeout(activity, 50);
    runtime.flashTimer = setTimeout(flash, 50);

    runtimes.dispose(1);
    vi.advanceTimersByTime(200);

    expect(activity).not.toHaveBeenCalled();
    expect(flash).not.toHaveBeenCalled();
  });

  it("dispose returns the session id ONCE and is idempotent afterwards", () => {
    const runtimes = createPaneRuntimes();
    const runtime = runtimes.ensure(1, fakeCwd());
    runtime.sessionId = 42;

    // The id must be captured BEFORE the record is dropped — App still has to close that session.
    expect(runtimes.dispose(1)).toEqual({ sessionId: 42 });
    expect(runtimes.get(1)).toBeUndefined();
    // A second dispose must not report the session again: App would close it twice.
    expect(runtimes.dispose(1)).toEqual({});
  });

  it("dispose of an unknown pane is a no-op", () => {
    expect(createPaneRuntimes().dispose(99)).toEqual({});
  });

  it("ensure is idempotent and never clobbers a live record", () => {
    const runtimes = createPaneRuntimes();
    const first = runtimes.ensure(1, fakeCwd());
    first.sessionId = 7;
    first.osc133 = true;

    const second = runtimes.ensure(1, fakeCwd());

    expect(second).toBe(first);
    expect(second.sessionId).toBe(7);
    expect(second.osc133).toBe(true);
  });

  it("clearAllTimers cancels every pane's timers", () => {
    const runtimes = createPaneRuntimes();
    const fired: string[] = [];
    for (const id of [1, 2]) {
      const runtime = runtimes.ensure(id, fakeCwd());
      runtime.activityTimer = setTimeout(() => fired.push(`activity${id}`), 50);
      runtime.flashTimer = setTimeout(() => fired.push(`flash${id}`), 50);
    }

    runtimes.clearAllTimers();
    vi.advanceTimersByTime(200);

    expect(fired).toEqual([]);
  });

  it("clearAllTimers PRESERVES every record and its non-timer fields", () => {
    // The StrictMode trap: React replays an effect's cleanup while the component is still mounted,
    // so App's unmount effect runs on a LIVE app. A bulk operation that dropped records would wipe
    // pending cwd, cached callbacks, sessions and attach epochs right before the remount.
    const runtimes = createPaneRuntimes();
    const runtime: PaneRuntime = runtimes.ensure(1, fakeCwd());
    runtime.sessionId = 42;
    runtime.pendingCwd = "/work";
    runtime.attachEpoch = 3;
    runtime.osc133 = true;
    runtime.onReady = vi.fn();
    runtime.activityTimer = setTimeout(() => {}, 50);

    runtimes.clearAllTimers();

    expect(runtimes.get(1)).toBe(runtime); // same record, not a replacement
    expect(runtime.sessionId).toBe(42);
    expect(runtime.pendingCwd).toBe("/work");
    expect(runtime.attachEpoch).toBe(3);
    expect(runtime.osc133).toBe(true);
    expect(runtime.onReady).toBeTypeOf("function");
    expect(runtime.activityTimer).toBeUndefined(); // only the timer is gone
  });
});
