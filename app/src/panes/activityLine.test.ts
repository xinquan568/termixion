// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-91 (sub-task D, test-first): the pure activity-line debounce. Time is INJECTED (plain
// numbers for `now` / deadlines) — no fake timers, no wall-clock — so the two thresholds are pinned
// exactly: busy must persist >= SHOW_DELAY_MS to ever show (an instant job never flashes), and once
// shown the line holds >= MIN_VISIBLE_MS from shownAt (rapid short jobs can't strobe it).
import { describe, it, expect } from "vitest";
import {
  SHOW_DELAY_MS,
  MIN_VISIBLE_MS,
  initialActivity,
  isVisible,
  onBusyChange,
  onDeadline,
  parseActivityPayload,
  type ActivityState,
} from "./activityLine";

describe("activityLine debounce (trmx-91)", () => {
  it("pins the two thresholds at 150 ms / 300 ms", () => {
    expect(SHOW_DELAY_MS).toBe(150);
    expect(MIN_VISIBLE_MS).toBe(300);
  });

  it("starts idle and not visible", () => {
    const state = initialActivity();
    expect(isVisible(state)).toBe(false);
  });

  it("does not show a job shorter than the show delay (instant `ls` never flashes)", () => {
    // busy@0 -> pendingShow (not yet visible), armed for 150.
    const shown = onBusyChange(initialActivity(), true, 0);
    expect(isVisible(shown.state)).toBe(false);
    expect(shown.deadline).toBe(SHOW_DELAY_MS);

    // idle@100 (before the 150 floor) -> back to idle, timer cancelled, never shown.
    const dropped = onBusyChange(shown.state, false, 100);
    expect(isVisible(dropped.state)).toBe(false);
    expect(dropped.deadline).toBeNull();

    // Even a stale timer firing at 150 (one the App did not cancel) stays inert.
    const stale = onDeadline(dropped.state, 150);
    expect(isVisible(stale.state)).toBe(false);
    expect(stale.deadline).toBeNull();
  });

  it("shows a job that persists at least the show delay", () => {
    const pending = onBusyChange(initialActivity(), true, 0);
    expect(pending.deadline).toBe(150);

    // Timer fires at 150 with busy still held -> visible, shownAt recorded (= now), no timer pending.
    const visible = onDeadline(pending.state, 150);
    expect(isVisible(visible.state)).toBe(true);
    expect(visible.deadline).toBeNull();
  });

  it("re-arms (does not show early) if a show timer fires before the floor", () => {
    const pending = onBusyChange(initialActivity(), true, 0);
    const early = onDeadline(pending.state, 140); // spurious early fire
    expect(isVisible(early.state)).toBe(false);
    expect(early.deadline).toBe(150); // re-armed to the real show time
    // The real fire then shows.
    expect(isVisible(onDeadline(early.state, 150).state)).toBe(true);
  });

  it("keeps a shown line visible for at least the min-visible window, then hides", () => {
    // busy@0 -> pendingShow; fire@150 -> visible with shownAt=150.
    const visible = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150);
    expect(isVisible(visible.state)).toBe(true);

    // idle@200 (only 50 ms after shown) -> pendingHide, still ON-SCREEN, armed for shownAt+300=450.
    const holding = onBusyChange(visible.state, false, 200);
    expect(isVisible(holding.state)).toBe(true);
    expect(holding.deadline).toBe(150 + MIN_VISIBLE_MS); // 450

    // An early hide timer @400 (before 450) does NOT hide — re-arms to 450, stays visible.
    const early = onDeadline(holding.state, 400);
    expect(isVisible(early.state)).toBe(true);
    expect(early.deadline).toBe(450);

    // At 450 the min-visible floor is reached -> hides.
    const hidden = onDeadline(early.state, 450);
    expect(isVisible(hidden.state)).toBe(false);
    expect(hidden.deadline).toBeNull();
  });

  it("hides immediately-ish when idle arrives after the min-visible window has already passed", () => {
    const visible = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150); // shownAt=150
    // idle@600 (well past shownAt+300=450) -> pendingHide armed for max(now, 450) = now, fires now.
    const holding = onBusyChange(visible.state, false, 600);
    expect(holding.deadline).toBe(600);
    expect(isVisible(onDeadline(holding.state, 600).state)).toBe(false);
  });

  it("does not strobe when busy flaps on and off after the line is shown", () => {
    let cur = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150).state; // visible, shownAt=150
    const timeline: boolean[] = [isVisible(cur)];
    // Flap idle/busy repeatedly, all within the min-visible hold window.
    for (const [busy, t] of [
      [false, 200],
      [true, 210],
      [false, 220],
      [true, 230],
      [false, 240],
      [true, 250],
    ] as const) {
      cur = onBusyChange(cur, busy, t).state;
      timeline.push(isVisible(cur));
    }
    // Never dropped off-screen through the whole flap sequence — no strobe.
    expect(timeline.every((v) => v === true)).toBe(true);
  });

  it("re-shows without a new delay when busy returns during the hide hold", () => {
    const visible = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150);
    const holding = onBusyChange(visible.state, false, 200); // pendingHide
    const reBusy = onBusyChange(holding.state, true, 210); // busy again during the hold
    expect(isVisible(reBusy.state)).toBe(true);
    expect(reBusy.deadline).toBeNull(); // straight back to visible, no timer
  });

  it("is a no-op when idle is re-asserted while already idle", () => {
    const idle = initialActivity();
    const again = onBusyChange(idle, false, 42);
    expect(isVisible(again.state)).toBe(false);
    expect(again.deadline).toBeNull();
  });

  it("is a no-op when busy is re-asserted while already visible", () => {
    const visible = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150);
    const again = onBusyChange(visible.state, true, 160);
    expect(isVisible(again.state)).toBe(true);
    expect(again.deadline).toBeNull();
  });

  it("ignores a stale deadline that fires after the line is already visible", () => {
    const visible = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150);
    const stale = onDeadline(visible.state, 500);
    expect(isVisible(stale.state)).toBe(true);
    expect(stale.deadline).toBeNull();
  });

  it("is deterministic: the same event sequence yields the same visibility timeline", () => {
    // A script of (kind, arg, time) events driving the machine from a fresh start.
    type Ev =
      | { kind: "busy"; busy: boolean; t: number }
      | { kind: "timer"; t: number };
    const script: Ev[] = [
      { kind: "busy", busy: true, t: 0 },
      { kind: "timer", t: 150 },
      { kind: "busy", busy: false, t: 200 },
      { kind: "busy", busy: true, t: 220 },
      { kind: "busy", busy: false, t: 260 },
      { kind: "timer", t: 560 },
      { kind: "busy", busy: true, t: 600 },
      { kind: "timer", t: 750 },
      { kind: "busy", busy: false, t: 800 },
      { kind: "timer", t: 1100 },
    ];
    const run = (): Array<{ visible: boolean; deadline: number | null }> => {
      let state: ActivityState = initialActivity();
      const trace: Array<{ visible: boolean; deadline: number | null }> = [];
      for (const ev of script) {
        const step = ev.kind === "busy" ? onBusyChange(state, ev.busy, ev.t) : onDeadline(state, ev.t);
        state = step.state;
        trace.push({ visible: isVisible(state), deadline: step.deadline });
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });
});

describe("parseActivityPayload (trmx-91)", () => {
  it("accepts a valid { sessionId, busy } payload", () => {
    expect(parseActivityPayload({ sessionId: 7, busy: true })).toEqual({ sessionId: 7, busy: true });
    expect(parseActivityPayload({ sessionId: 0, busy: false })).toEqual({ sessionId: 0, busy: false });
  });

  it("ignores extra fields, keeping only sessionId and busy", () => {
    expect(parseActivityPayload({ sessionId: 3, busy: true, extra: "x" })).toEqual({
      sessionId: 3,
      busy: true,
    });
  });

  it("rejects a non-object / null / primitive payload", () => {
    expect(parseActivityPayload(null)).toBeNull();
    expect(parseActivityPayload(undefined)).toBeNull();
    expect(parseActivityPayload(42)).toBeNull();
    expect(parseActivityPayload("busy")).toBeNull();
    expect(parseActivityPayload(true)).toBeNull();
  });

  it("rejects a missing or mistyped field", () => {
    expect(parseActivityPayload({})).toBeNull();
    expect(parseActivityPayload({ sessionId: 7 })).toBeNull(); // busy missing
    expect(parseActivityPayload({ busy: true })).toBeNull(); // sessionId missing
    expect(parseActivityPayload({ sessionId: "7", busy: true })).toBeNull(); // string id
    expect(parseActivityPayload({ sessionId: 7, busy: 1 })).toBeNull(); // numeric busy
    expect(parseActivityPayload({ sessionId: 7, busy: "true" })).toBeNull(); // string busy
  });

  it("rejects a typo'd field name", () => {
    expect(parseActivityPayload({ session_id: 7, busy: true })).toBeNull();
    expect(parseActivityPayload({ sessionId: 7, active: true })).toBeNull();
  });

  it("rejects a non-integer sessionId (NaN / Infinity / fractional are junk)", () => {
    expect(parseActivityPayload({ sessionId: Number.NaN, busy: true })).toBeNull();
    expect(parseActivityPayload({ sessionId: Number.POSITIVE_INFINITY, busy: true })).toBeNull();
    expect(parseActivityPayload({ sessionId: 1.5, busy: true })).toBeNull();
  });
});
