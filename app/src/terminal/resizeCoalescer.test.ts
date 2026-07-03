// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-67 (test-first): trailing-edge resize coalescing. A live window drag makes ResizeObserver
// fire on every layout pass; the coalescer must fold any synchronous burst of ticks into exactly
// one run() on the next frame, never drop the settled (final) tick, and never run after dispose —
// even against a schedule that ignores its cancel. The frame source is injected, so these tests
// drive a manual fake frame and fire it explicitly (no timers, no rAF races).
import { describe, it, expect, vi } from "vitest";
import { makeResizeCoalescer } from "./resizeCoalescer";

/**
 * A manual frame source: captures the scheduled callback so the test decides when the "frame"
 * fires; the returned cancel is a spy that deliberately does NOT clear the captured callback —
 * firing after a cancel is how we prove the coalescer guards itself instead of trusting the
 * schedule to honor cancellation.
 */
function manualFrame() {
  let captured: (() => void) | undefined;
  const cancel = vi.fn();
  const schedule = vi.fn((cb: () => void) => {
    captured = cb;
    return cancel;
  });
  return { schedule, cancel, fire: () => captured?.() };
}

describe("makeResizeCoalescer", () => {
  it("runs the first tick on the very next frame — not synchronously", () => {
    const run = vi.fn();
    const frame = manualFrame();
    const coalescer = makeResizeCoalescer(run, frame.schedule);

    coalescer.tick();
    expect(frame.schedule).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();

    frame.fire();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("coalesces a synchronous burst: 20 ticks schedule one frame and run once when it fires", () => {
    const run = vi.fn();
    const frame = manualFrame();
    const coalescer = makeResizeCoalescer(run, frame.schedule);

    for (let i = 0; i < 20; i++) coalescer.tick();

    // No double-scheduling while a frame is pending, and nothing runs until the frame fires.
    expect(frame.schedule).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();

    frame.fire();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a tick after the frame fires schedules a new frame — the settled tick is never dropped", () => {
    const run = vi.fn();
    const frame = manualFrame();
    const coalescer = makeResizeCoalescer(run, frame.schedule);

    coalescer.tick();
    frame.fire();
    expect(run).toHaveBeenCalledTimes(1);

    // The world moved on after the last frame; this tick must get its own frame.
    coalescer.tick();
    expect(frame.schedule).toHaveBeenCalledTimes(2);
    frame.fire();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("dispose cancels the pending frame AND guards run() against a frame that fires anyway", () => {
    const run = vi.fn();
    const frame = manualFrame();
    const coalescer = makeResizeCoalescer(run, frame.schedule);

    coalescer.tick();
    coalescer.dispose();
    expect(frame.cancel).toHaveBeenCalledTimes(1);

    // The fake ignores the cancel and fires the captured callback anyway: the coalescer's own
    // disposed guard — not the schedule's cancel — must keep run() from executing.
    frame.fire();
    expect(run).not.toHaveBeenCalled();
  });

  it("ticks after dispose neither schedule nor run", () => {
    const run = vi.fn();
    const frame = manualFrame();
    const coalescer = makeResizeCoalescer(run, frame.schedule);

    coalescer.dispose();
    coalescer.tick();
    expect(frame.schedule).not.toHaveBeenCalled();
    frame.fire();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps coalescing correctly when the schedule fires synchronously (immediate frame)", () => {
    // TerminalView tests inject exactly this schedule to make fits deterministic — a run must not
    // wedge the coalescer's pending state, so every subsequent tick still runs.
    const run = vi.fn();
    const coalescer = makeResizeCoalescer(run, (cb) => {
      cb();
      return () => {};
    });

    coalescer.tick();
    coalescer.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("defaults to requestAnimationFrame / cancelAnimationFrame when no schedule is injected", () => {
    // jsdom provides rAF; capture the frame callback via a spy so the test controls the frame.
    let frameCb: FrameRequestCallback | undefined;
    const raf = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((cb) => {
        frameCb = cb;
        return 7;
      });
    const caf = vi
      .spyOn(globalThis, "cancelAnimationFrame")
      .mockImplementation(() => {});
    try {
      const run = vi.fn();
      const coalescer = makeResizeCoalescer(run);

      coalescer.tick();
      expect(raf).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
      frameCb?.(0);
      expect(run).toHaveBeenCalledTimes(1);

      // dispose with a frame pending revokes it through cancelAnimationFrame.
      coalescer.tick();
      coalescer.dispose();
      expect(caf).toHaveBeenCalledWith(7);
    } finally {
      raf.mockRestore();
      caf.mockRestore();
    }
  });

  it("falls back to setTimeout(cb, 16) / clearTimeout when rAF is absent", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    try {
      const run = vi.fn();
      const coalescer = makeResizeCoalescer(run);

      coalescer.tick();
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(16);
      expect(run).toHaveBeenCalledTimes(1);

      // dispose clears a pending fallback timer — no late run.
      coalescer.tick();
      coalescer.dispose();
      vi.advanceTimersByTime(1000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
