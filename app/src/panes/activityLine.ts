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
//
// trmx-159: layered ON TOP of that phase debounce (the `rawBusy` machine, UNCHANGED — its close-guard
// contract and every threshold pin still hold) is a per-epoch CLASSIFICATION + activity-window layer
// that decides `lightActive` — whether the visible line/dot should light while the program is actually
// EXECUTING user work. `rawBusy` (isBusy) still drives the close guard; `lightActive` drives the UI.
// The phase functions (onBusyChange/onDeadline) keep returning the PHASE deadline unchanged (so their
// tests are intact); the class-layer deadlines are surfaced separately via `classDeadline`, which App
// folds with the phase deadline into its one per-pane timer. See interactivePrograms.ts for the class.
import { classifyInvocation } from "./interactivePrograms";

/** Busy must persist at least this long (ms) before the activity line appears. */
export const SHOW_DELAY_MS = 150;

/** Once shown, the activity line stays visible at least this long (ms) total, measured from shownAt. */
export const MIN_VISIBLE_MS = 300;

// trmx-159 tunables (not user-facing). A busy epoch classified `interactive` lights only while it is
// recently producing output in response to a submit; a still-`unknown` epoch falls back to `plain`.
/** An interactive epoch stays lit at most this long (ms) since its last counted output. */
export const HOLD_MS = 3000;
/** The interactive activity window closes after this long (ms) of counted-output silence. */
export const WINDOW_CLOSE_MS = 10000;
/** An epoch still `unknown` this long (ms) after its rise falls back to `plain` (status-quo lighting). */
export const UNKNOWN_FALLBACK_MS = 1500;
/** Output within this long (ms) of a keystroke, and no larger than {@link ECHO_MAX_BYTES}, is echo. */
export const ECHO_WINDOW_MS = 300;
/** Output larger than this (bytes) is real work even right after a keystroke (never echo). */
export const ECHO_MAX_BYTES = 2048;

/**
 * The debounce phase. Opaque to callers — drive it only through {@link onBusyChange} /
 * {@link onDeadline} and read it through {@link isVisible}. Both `pendingHide` and `visible` are
 * on-screen (the min-visible hold keeps the line up while idle); `pendingShow` is NOT yet on-screen.
 */
type ActivityPhase = "idle" | "pendingShow" | "visible" | "pendingHide";

/** trmx-159: an epoch's class for the light — `unknown` is transient (never terminal; fails dark). */
export type ActivityClass = "plain" | "interactive" | "unknown";

/**
 * The per-pane debounce + classification state. Opaque internal shape. Phase fields (`phase`,
 * `busySince`, `shownAt`) are the trmx-91 rawBusy machine; the trmx-159 fields layer classification +
 * the interactive activity window on top:
 * - `rawBusy` — mirrors the phase (pendingShow/visible), the close-guard signal; see {@link isBusy}.
 * - `busyEpoch` — bumped on every rawBusy false→true rise; a fresh epoch is born un-armed.
 * - `klass` — the epoch's classification; `interactive` gates on the activity window, `plain` on
 *   rawBusy (today's behavior), `unknown` fails dark until classified or the fallback fires.
 * - `unknownSince` — set while `klass==="unknown"` (and rawBusy); the fallback fires at +UNKNOWN_FALLBACK_MS.
 * - `foregroundName` — the classified basename, for in-epoch reclassification on a changed name.
 * - `pendingSubmit` — an Enter arrived while `unknown`; honored on classify→interactive, dropped on plain.
 * - `windowOpen` — the interactive activity window (opened by a submit) is open.
 * - `windowActivityAt` — the last window activity (submit OR counted output); the window closes at +WINDOW_CLOSE_MS.
 * - `lastCountedOutputAt` — the last NON-echo output; `lightActive` needs it within HOLD_MS.
 * - `lastInputAt` — the last keystroke, for echo suppression of the output it provokes.
 */
export interface ActivityState {
  readonly phase: ActivityPhase;
  readonly busySince?: number;
  readonly shownAt?: number;
  readonly rawBusy: boolean;
  readonly busyEpoch: number;
  readonly klass: ActivityClass;
  readonly unknownSince?: number;
  readonly foregroundName?: string;
  readonly pendingSubmit: boolean;
  readonly windowOpen: boolean;
  readonly windowActivityAt?: number;
  readonly lastCountedOutputAt?: number;
  readonly lastInputAt?: number;
  /**
   * trmx-191: the ⌘⇧A manual override — a ONE-SHOT presentation correction (undefined = none).
   * {@link lightActive} consults it FIRST; {@link isBusy} (the trmx-144 close guard) NEVER does.
   * Auto-clears on the next detector-transition event — every {@link onBusyChange} invocation is
   * one by upstream contract (the poller emits change-only; the OSC 133 path is busyChanged-
   * guarded) — including a fall that finds this state already idle (the missed-rise recovery).
   * Non-detector inputs (deadline fires, output, input, classify) leave it alone.
   */
  readonly override?: "on" | "off";
}

/** trmx-159: the classification metadata the poller carries on a busy rise (each field independent). */
export interface ActivityMeta {
  readonly name?: string;
  readonly args?: string[];
  readonly stdinTty?: boolean;
}

/**
 * The result of a transition: the next {@link ActivityState}, and the absolute timestamp the App
 * should arm its single per-pane timer to (or null to leave no timer pending). PHASE transitions
 * return the PHASE deadline here (unchanged from trmx-91); App folds in {@link classDeadline}.
 */
export interface ActivityTransition {
  readonly state: ActivityState;
  readonly deadline: number | null;
}

function transition(state: ActivityState, deadline: number | null): ActivityTransition {
  return { state, deadline };
}

/** Whether a phase is rawBusy (a job is running right now): pre-show counts, the linger does not. */
function rawBusyOf(phase: ActivityPhase): boolean {
  return phase === "pendingShow" || phase === "visible";
}

/**
 * The absolute time the min-visible hold ends, never earlier than `now` (so the App always gets a
 * schedulable, non-negative delay even if the line has already been up past the floor). `shownAt`
 * is present in every on-screen phase; the `?? now` is a total-function guard, not a reachable path.
 */
function hideDeadline(state: ActivityState, now: number): number {
  return Math.max(now, (state.shownAt ?? now) + MIN_VISIBLE_MS);
}

/** A fresh, idle, not-visible, un-classified state — one per pane. */
export function initialActivity(): ActivityState {
  return {
    phase: "idle",
    rawBusy: false,
    busyEpoch: 0,
    klass: "plain",
    pendingSubmit: false,
    windowOpen: false,
  };
}

/** Whether the activity line is on-screen right now (true through the whole min-visible hold). */
export function isVisible(state: ActivityState): boolean {
  return state.phase === "visible" || state.phase === "pendingHide";
}

/**
 * trmx-144: the RAW busy flag, distinct from the debounced presentation ({@link isVisible}) and from
 * the visible light ({@link lightActive}): true from the moment a busy=true change is applied —
 * including the pre-show window — and false the moment busy drops, including the min-visible linger.
 * The close guard reads THIS (is a job running right now?), so a close during an IDLE interactive
 * session (rawBusy true, lightActive false) is still guarded. trmx-159: kept phase-derived so it can
 * never desync from the debounce.
 */
export function isBusy(state: ActivityState): boolean {
  return rawBusyOf(state.phase);
}

/** The class layer of a fresh epoch: born classified from metadata, else `unknown` (+ fallback timer). */
function freshEpoch(epoch: number, now: number, meta: ActivityMeta | undefined): Partial<ActivityState> {
  if (meta?.name !== undefined) {
    const klass = classifyInvocation(meta.name, meta.args, meta.stdinTty);
    return {
      busyEpoch: epoch,
      klass,
      foregroundName: meta.name,
      unknownSince: undefined,
      pendingSubmit: false,
      windowOpen: false,
      windowActivityAt: undefined,
      lastCountedOutputAt: undefined,
    };
  }
  return {
    busyEpoch: epoch,
    klass: "unknown",
    foregroundName: undefined,
    unknownSince: now,
    pendingSubmit: false,
    windowOpen: false,
    windowActivityAt: undefined,
    lastCountedOutputAt: undefined,
  };
}

/**
 * Apply a busy<->idle flip at `now`, optionally with the poller's rise `meta` (so a poller-owned
 * epoch is born CLASSIFIED — no ordering window). Phase transitions and the returned PHASE deadline
 * are UNCHANGED from trmx-91:
 * - idle + busy -> pendingShow (deadline `now + SHOW_DELAY_MS`); idle + idle -> no-op.
 * - pendingShow + idle -> idle; pendingShow + busy -> stays pendingShow (idempotent).
 * - visible + idle -> pendingHide (deadline `max(now, shownAt + MIN_VISIBLE_MS)`); visible + busy -> no-op.
 * - pendingHide + busy -> visible again; pendingHide + idle -> idempotent.
 * A rawBusy false->true rise (idle->pendingShow, pendingHide->visible) starts a FRESH epoch (the class
 * layer resets); every other transition carries the class layer unchanged.
 */
export function onBusyChange(
  rawState: ActivityState,
  busy: boolean,
  now: number,
  meta?: ActivityMeta,
): ActivityTransition {
  // trmx-191: every invocation is a detector-transition event (change-only upstream), so the
  // manual override's one-shot life ends HERE — before the normal transition logic — which is
  // what lets a genuine fall clear a force-on even when the local phase never saw the rise.
  const state: ActivityState =
    rawState.override === undefined ? rawState : { ...rawState, override: undefined };
  const rise = (phase: ActivityPhase): ActivityState => ({
    ...state,
    ...freshEpoch(state.busyEpoch + 1, now, meta),
    phase,
    rawBusy: true,
    busySince: phase === "pendingShow" ? now : state.busySince,
  });
  switch (state.phase) {
    case "idle":
      return busy
        ? transition(rise("pendingShow"), now + SHOW_DELAY_MS)
        : transition(state, null);
    case "pendingShow":
      return busy
        ? transition(state, (state.busySince ?? now) + SHOW_DELAY_MS)
        : transition({ ...state, phase: "idle", rawBusy: false }, null);
    case "visible":
      return busy
        ? transition(state, null)
        : transition({ ...state, phase: "pendingHide", rawBusy: false }, hideDeadline(state, now));
    case "pendingHide":
      return busy
        ? transition(rise("visible"), null)
        : transition(state, hideDeadline(state, now));
  }
}

/**
 * A per-pane timer fired at `now` — re-evaluate against the phase (the truth), so a stale fire is
 * inert. Phase advancement is UNCHANGED from trmx-91; the returned deadline is the PHASE deadline
 * only. In ADDITION, trmx-159 class boundaries are advanced (unknown->plain fallback; window close),
 * which never change the phase or the phase deadline — App re-reads {@link classDeadline} after.
 */
export function onDeadline(state: ActivityState, now: number): ActivityTransition {
  let next = advanceClass(state, now);
  let deadline: number | null = null;
  switch (state.phase) {
    case "pendingShow": {
      const showAt = (state.busySince ?? now) + SHOW_DELAY_MS;
      if (now >= showAt) next = { ...next, phase: "visible", rawBusy: true, shownAt: now };
      else deadline = showAt;
      break;
    }
    case "pendingHide": {
      const hideAt = (state.shownAt ?? now) + MIN_VISIBLE_MS;
      if (now >= hideAt) next = { ...next, phase: "idle", rawBusy: false };
      else deadline = hideAt;
      break;
    }
    case "idle":
    case "visible":
      break;
  }
  return transition(next, deadline);
}

/** Advance ONLY the class-layer time boundaries at `now` (no phase change): unknown->plain, window close. */
function advanceClass(state: ActivityState, now: number): ActivityState {
  let next = state;
  if (
    next.klass === "unknown" &&
    isBusy(next) &&
    next.unknownSince !== undefined &&
    now >= next.unknownSince + UNKNOWN_FALLBACK_MS
  ) {
    next = { ...next, klass: "plain", unknownSince: undefined, pendingSubmit: false };
  }
  if (
    next.windowOpen &&
    next.windowActivityAt !== undefined &&
    now >= next.windowActivityAt + WINDOW_CLOSE_MS
  ) {
    next = { ...next, windowOpen: false };
  }
  return next;
}

/**
 * trmx-159: classify (or re-classify) the current epoch from the poller's foreground metadata. Only
 * meaningful while rawBusy. An `unknown` epoch adopts the class (honoring a buffered pendingSubmit on
 * `interactive`, discarding it on `plain`); an already-classified epoch RE-classifies only when the
 * foreground NAME changed (a new program took over), resetting its window. No-op otherwise. Phase is
 * untouched, so the returned deadline is null (App folds {@link classDeadline}).
 */
export function onClassifyMetadata(
  state: ActivityState,
  meta: ActivityMeta,
  now: number,
): ActivityTransition {
  if (!isBusy(state) || meta.name === undefined) return transition(state, null);
  const klass = classifyInvocation(meta.name, meta.args, meta.stdinTty);
  const nameChanged = state.foregroundName !== meta.name;
  if (state.klass !== "unknown" && !nameChanged) return transition(state, null);

  let next: ActivityState = {
    ...state,
    klass,
    foregroundName: meta.name,
    unknownSince: undefined,
    // A reclassification (name change) resets the window; a first classification has none yet.
    windowOpen: false,
    windowActivityAt: undefined,
    lastCountedOutputAt: undefined,
  };
  if (klass === "interactive" && state.pendingSubmit) {
    // Honor an Enter that was buffered while unknown: open the window as of now (arming shows nothing).
    next = { ...next, windowOpen: true, windowActivityAt: now, pendingSubmit: false };
  } else {
    next = { ...next, pendingSubmit: false };
  }
  return transition(next, null);
}

/**
 * trmx-159: observe keystroke input at `now`. Records the keystroke time (for echo suppression) and,
 * on an Enter (`\r`/`\n`) while rawBusy, arms a submit: an `interactive` epoch opens/renews its
 * window (arming alone shows nothing — output recency lights it); an `unknown` epoch buffers a
 * `pendingSubmit`; a `plain` epoch ignores it. An Enter while NOT rawBusy (the idle shell) is the
 * command LAUNCH keystroke and arms nothing — the imminent rise starts a fresh, un-armed epoch.
 */
export function onInput(state: ActivityState, data: string, now: number): ActivityTransition {
  let next: ActivityState = { ...state, lastInputAt: now };
  const submitted = data.includes("\r") || data.includes("\n");
  if (submitted && isBusy(next)) {
    if (next.klass === "interactive") {
      next = {
        ...next,
        windowOpen: true,
        windowActivityAt: now,
        lastCountedOutputAt: undefined,
        pendingSubmit: false,
      };
    } else if (next.klass === "unknown") {
      next = { ...next, pendingSubmit: true };
    }
  }
  return transition(next, null);
}

/**
 * trmx-159: observe `byteLength` bytes of PTY output at `now`. Echo suppression: output within
 * ECHO_WINDOW_MS of the last keystroke and no larger than ECHO_MAX_BYTES is the terminal echoing
 * the keystroke, not work — it does not count. Counted output in an OPEN interactive window refreshes
 * the recency clock (which lights the line for HOLD_MS) and renews the window; output outside an open
 * interactive window (a launch banner, a post-response repaint, a plain/unknown epoch) is ignored.
 */
export function onOutput(state: ActivityState, byteLength: number, now: number): ActivityTransition {
  if (!isBusy(state)) return transition(state, null);
  const isEcho =
    state.lastInputAt !== undefined &&
    now - state.lastInputAt <= ECHO_WINDOW_MS &&
    byteLength <= ECHO_MAX_BYTES;
  if (isEcho) return transition(state, null);
  if (state.klass === "interactive" && state.windowOpen) {
    return transition(
      { ...state, lastCountedOutputAt: now, windowActivityAt: now },
      null,
    );
  }
  return transition(state, null);
}

/**
 * trmx-159: the class-layer deadline (absolute ms, or null) the App folds with the phase deadline into
 * its single per-pane timer — the soonest time the classification / window / light state next changes:
 * the unknown->plain fallback, the interactive light-off (HOLD_MS after the last counted output), and
 * the window close (WINDOW_CLOSE_MS after the last window activity). Returns only FUTURE times (> now).
 */
export function classDeadline(state: ActivityState, now: number): number | null {
  const cands: number[] = [];
  if (state.klass === "unknown" && isBusy(state) && state.unknownSince !== undefined) {
    cands.push(state.unknownSince + UNKNOWN_FALLBACK_MS);
  }
  if (state.windowOpen) {
    if (lightActive(state, now) && state.lastCountedOutputAt !== undefined) {
      // Fire just after the hold ends so App re-renders the (now unlit) line.
      cands.push(state.lastCountedOutputAt + HOLD_MS + 1);
    }
    if (state.windowActivityAt !== undefined) {
      cands.push(state.windowActivityAt + WINDOW_CLOSE_MS);
    }
  }
  const future = cands.filter((t) => t > now);
  return future.length === 0 ? null : Math.min(...future);
}

/**
 * trmx-159: whether the VISIBLE line/dot should light right now — the debounced base gate
 * ({@link isVisible}, so an instant job never flashes and a shown line keeps its min-visible hold)
 * AND the class gate: `plain` lights whenever visible (today's behavior); `unknown` never lights
 * (fail-dark); `interactive` lights only while its window is open and it produced counted output
 * within HOLD_MS (actually executing user work). The close guard still reads {@link isBusy}, not this.
 */
export function lightActive(state: ActivityState, now: number): boolean {
  // trmx-191: the manual override outranks everything below — a forced light neither decays with
  // the interactive window nor waits for the debounce; only a detector event (onBusyChange) ends it.
  if (state.override !== undefined) return state.override === "on";
  if (!isVisible(state)) return false;
  switch (state.klass) {
    case "plain":
      return true;
    case "interactive":
      return (
        state.windowOpen &&
        state.lastCountedOutputAt !== undefined &&
        now - state.lastCountedOutputAt <= HOLD_MS
      );
    case "unknown":
    default:
      return false;
  }
}

/**
 * trmx-191: apply the ⌘⇧A manual force. The DIRECTION is the caller's decision (App derives it
 * from the RENDERED state — `lightActive || flashing` — so a flash-only stuck bar forces off);
 * this machine only records the one-shot override. The returned deadline PRESERVES the live phase
 * timer: App's applyActivityTransition clears-then-rearms from the returned value, so returning
 * null mid-`pendingShow`/`pendingHide` would strand the phase forever.
 */
export function onManualToggle(
  state: ActivityState,
  force: "on" | "off",
  now: number,
): ActivityTransition {
  const next: ActivityState = { ...state, override: force };
  switch (state.phase) {
    case "pendingShow":
      return transition(next, (state.busySince ?? now) + SHOW_DELAY_MS);
    case "pendingHide":
      return transition(next, hideDeadline(state, now));
    default:
      return transition(next, null);
  }
}

/**
 * Guard for the `session:activity` event payload (untrusted, like cursorSettings.ts): a valid
 * `{ sessionId, busy }` with an integer `sessionId` (a backend session handle — NaN / +-Infinity /
 * fractional are junk) and a boolean `busy`. trmx-159: also parses the OPTIONAL rise metadata
 * (`foregroundName`/`foregroundArgs`/`foregroundStdinTty`), each validated independently and dropped
 * if junk, into `meta` (absent when no metadata is present). Anything invalid at the core yields null.
 */
export function parseActivityPayload(
  payload: unknown,
): { sessionId: number; busy: boolean; meta?: ActivityMeta } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const {
    sessionId,
    busy,
    foregroundName,
    foregroundArgs,
    foregroundStdinTty,
  } = payload as {
    sessionId?: unknown;
    busy?: unknown;
    foregroundName?: unknown;
    foregroundArgs?: unknown;
    foregroundStdinTty?: unknown;
  };
  // review-1: the SAME positive-safe-integer guard the other session ingress points use (ipc/backend
  // isSessionId) — the backend allocates positive u64 handles, so 0 / negative / unsafe are junk.
  if (typeof sessionId !== "number" || !Number.isSafeInteger(sessionId) || sessionId <= 0) return null;
  if (typeof busy !== "boolean") return null;

  const meta: { name?: string; args?: string[]; stdinTty?: boolean } = {};
  if (typeof foregroundName === "string") meta.name = foregroundName;
  if (Array.isArray(foregroundArgs) && foregroundArgs.every((a) => typeof a === "string")) {
    meta.args = foregroundArgs as string[];
  }
  if (typeof foregroundStdinTty === "boolean") meta.stdinTty = foregroundStdinTty;

  return Object.keys(meta).length > 0
    ? { sessionId, busy, meta }
    : { sessionId, busy };
}
