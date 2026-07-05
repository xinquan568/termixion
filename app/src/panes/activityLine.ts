// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-91 (sub-task D): the PURE, time-injected debounce for a pane's activity line (the "busy"
// indicator that a session is running a foreground job). Two thresholds keep it from flickering:
// busy must PERSIST >= SHOW_DELAY_MS before the line appears (so an instant `ls` never flashes),
// and once shown the line stays up for at least MIN_VISIBLE_MS total (so a burst of rapid short
// jobs can't strobe it). Modeled on badgeVisible.ts (a standalone pure pane helper, no React / DOM)
// and cursorSettings.ts (events are untrusted input — a payload guard makes junk inert): the timing
// is a state machine over an OPAQUE phase, with NO wall-clock read inside. The caller (App) injects
// `now` on every transition and owns the single per-pane timer, arming it to the returned `deadline`
// (an absolute timestamp, or null for "no timer pending") and calling back into `onDeadline` when it
// fires. That keeps every rule unit-testable headless with plain injected numbers, and makes a stale
// timer fire (one the App did not manage to cancel) inert — the phase, not the clock, is the truth.

/** Busy must persist at least this long (ms) before the activity line appears. */
export const SHOW_DELAY_MS = 150;

/** Once shown, the activity line stays visible at least this long (ms) total, measured from shownAt. */
export const MIN_VISIBLE_MS = 300;

/**
 * The debounce phase. Opaque to callers — drive it only through {@link onBusyChange} /
 * {@link onDeadline} and read it through {@link isVisible}. Both `pendingHide` and `visible` are
 * on-screen (the min-visible hold keeps the line up while idle); `pendingShow` is NOT yet on-screen.
 */
type ActivityPhase = "idle" | "pendingShow" | "visible" | "pendingHide";

/**
 * The per-pane debounce state. Opaque internal shape:
 * - `busySince` — set in `pendingShow`; the show fires at `busySince + SHOW_DELAY_MS`.
 * - `shownAt` — set once the line is on-screen (`visible` / `pendingHide`); the min-visible hold
 *   ends at `shownAt + MIN_VISIBLE_MS`. Anchored to the FIRST show, so busy flapping never re-extends
 *   (or resets) the hold beyond the original window.
 */
export interface ActivityState {
  readonly phase: ActivityPhase;
  readonly busySince?: number;
  readonly shownAt?: number;
}

/**
 * The result of a transition: the next {@link ActivityState}, and the absolute timestamp the App
 * should arm its single per-pane timer to (or null to leave no timer pending). The App clears any
 * prior timer and, when `deadline` is non-null, schedules a callback into {@link onDeadline}.
 */
export interface ActivityTransition {
  readonly state: ActivityState;
  readonly deadline: number | null;
}

function transition(state: ActivityState, deadline: number | null): ActivityTransition {
  return { state, deadline };
}

/**
 * The absolute time the min-visible hold ends, never earlier than `now` (so the App always gets a
 * schedulable, non-negative delay even if the line has already been up past the floor). `shownAt`
 * is present in every on-screen phase; the `?? now` is a total-function guard, not a reachable path.
 */
function hideDeadline(state: ActivityState, now: number): number {
  return Math.max(now, (state.shownAt ?? now) + MIN_VISIBLE_MS);
}

/** A fresh, idle, not-visible state — one per pane. */
export function initialActivity(): ActivityState {
  return { phase: "idle" };
}

/** Whether the activity line is on-screen right now (true through the whole min-visible hold). */
export function isVisible(state: ActivityState): boolean {
  return state.phase === "visible" || state.phase === "pendingHide";
}

/**
 * Apply a busy<->idle flip at `now`. Transitions:
 * - idle + busy -> pendingShow (deadline `now + SHOW_DELAY_MS`); idle + idle -> no-op.
 * - pendingShow + idle -> idle (busy dropped before the show fired: never shown, no flicker);
 *   pendingShow + busy -> stays pendingShow (idempotent; the delay is measured from the first busy).
 * - visible + idle -> pendingHide (deadline `max(now, shownAt + MIN_VISIBLE_MS)`); visible + busy -> no-op.
 * - pendingHide + busy -> visible again (no strobe on a rapid re-busy); pendingHide + idle -> idempotent.
 */
export function onBusyChange(state: ActivityState, busy: boolean, now: number): ActivityTransition {
  switch (state.phase) {
    case "idle":
      return busy
        ? transition({ phase: "pendingShow", busySince: now }, now + SHOW_DELAY_MS)
        : transition(state, null);
    case "pendingShow":
      return busy
        ? transition(state, (state.busySince ?? now) + SHOW_DELAY_MS)
        : transition({ phase: "idle" }, null);
    case "visible":
      return busy
        ? transition(state, null)
        : transition({ phase: "pendingHide", shownAt: state.shownAt }, hideDeadline(state, now));
    case "pendingHide":
      return busy
        ? transition({ phase: "visible", shownAt: state.shownAt }, null)
        : transition(state, hideDeadline(state, now));
  }
}

/**
 * A per-pane timer fired at `now` — re-evaluate against the phase (the truth), so a stale fire is
 * inert. `pendingShow` and still past the show floor -> `visible` (records `shownAt`); `pendingHide`
 * and still past the min-visible floor -> `idle`. An early fire (before the floor) re-arms to the
 * real deadline; a fire in `idle`/`visible` (a timer the App did not cancel) is a no-op with no new
 * timer.
 */
export function onDeadline(state: ActivityState, now: number): ActivityTransition {
  switch (state.phase) {
    case "pendingShow": {
      const showAt = (state.busySince ?? now) + SHOW_DELAY_MS;
      return now >= showAt
        ? transition({ phase: "visible", shownAt: now }, null)
        : transition(state, showAt);
    }
    case "pendingHide": {
      const hideAt = (state.shownAt ?? now) + MIN_VISIBLE_MS;
      return now >= hideAt ? transition({ phase: "idle" }, null) : transition(state, hideAt);
    }
    case "idle":
    case "visible":
      return transition(state, null);
  }
}

/**
 * Guard for the `session:activity` event payload (untrusted, like cursorSettings.ts): a valid
 * `{ sessionId, busy }` with an integer `sessionId` (a backend session handle — NaN / +-Infinity /
 * fractional are junk) and a boolean `busy`. Anything else (non-object, null, missing / mistyped
 * fields) yields null so the caller can drop it without throwing.
 */
export function parseActivityPayload(payload: unknown): { sessionId: number; busy: boolean } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { sessionId, busy } = payload as { sessionId?: unknown; busy?: unknown };
  if (typeof sessionId !== "number" || !Number.isInteger(sessionId)) return null;
  if (typeof busy !== "boolean") return null;
  return { sessionId, busy };
}
