// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-67: trailing-edge, one-per-frame coalescing for the resize→fit path. A live window drag makes
// ResizeObserver fire on every layout pass — refitting on each tick would push a SIGWINCH storm down
// the PTY (one full reflow per tick, dozens per second). The coalescer folds any burst of ticks into
// a single run() on the next animation frame; run() executes against whatever state exists when the
// frame fires — the last tick's world — and the settled (final) tick is never dropped. Trailing-edge,
// not leading-edge, because the END state of a drag is the one that must stick.
//
// The module is pure and dependency-free (no DOM/xterm imports), the same split as `scrollbar.ts`:
// the frame source is injected (`schedule`) so the logic is unit-testable with a manual fake frame;
// the default wraps requestAnimationFrame, with a setTimeout(16ms) fallback for rAF-less hosts.

/** Schedule `cb` for the next animation frame; returns a cancel that revokes the pending frame. */
export type FrameSchedule = (cb: () => void) => () => void;

// The real frame source: rAF where the host provides it (browsers, jsdom), else one frame ≈ 16 ms of
// setTimeout. The typeof guards keep the module loadable in rAF-less hosts (bare workers, odd
// embedders) instead of throwing a ReferenceError at first tick.
const defaultSchedule: FrameSchedule = (cb) => {
  if (
    typeof requestAnimationFrame === "function" &&
    typeof cancelAnimationFrame === "function"
  ) {
    const id = requestAnimationFrame(() => cb());
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
};

/** A disposable trailing-edge coalescer: many `tick()`s per frame, one `run()` when the frame fires. */
export interface ResizeCoalescer {
  /** Note a resize. Schedules `run()` on the next frame unless one is already pending. */
  tick(): void;
  /** Cancel any pending frame. `run()` never executes after this — even if a frame fires anyway. */
  dispose(): void;
}

export function makeResizeCoalescer(
  run: () => void,
  schedule: FrameSchedule = defaultSchedule,
): ResizeCoalescer {
  let disposed = false;
  // True while a frame is pending — the coalescing gate: ticks inside the window are absorbed.
  let pending = false;
  let cancelFrame: (() => void) | undefined;

  return {
    tick() {
      if (disposed || pending) return;
      pending = true;
      const cancel = schedule(() => {
        pending = false;
        cancelFrame = undefined;
        // Load-bearing guard: dispose() cancels the frame, but a schedule that ignores its cancel
        // (a test fake, a misbehaving polyfill) may fire the callback anyway — never run after
        // dispose, on our own authority rather than the schedule's.
        if (disposed) return;
        run();
      });
      // A synchronous schedule (tests inject an immediate one) has already fired by here; its
      // cancel is stale, so keep it only while the frame is genuinely still pending.
      if (pending) cancelFrame = cancel;
    },
    dispose() {
      disposed = true;
      cancelFrame?.();
      cancelFrame = undefined;
      pending = false;
    },
  };
}
