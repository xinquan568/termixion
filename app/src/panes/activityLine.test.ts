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
  HOLD_MS,
  WINDOW_CLOSE_MS,
  UNKNOWN_FALLBACK_MS,
  ECHO_MAX_BYTES,
  initialActivity,
  isBusy,
  isVisible,
  lightActive,
  onBusyChange,
  onClassifyMetadata,
  onDeadline,
  onInput,
  onOutput,
  onManualToggle,
  classDeadline,
  parseActivityPayload,
  type ActivityMeta,
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

// trmx-191: the manual override — a ONE-SHOT correction (⌘⇧A). The machine APPLIES an explicit
// force (the direction is App's call, from the RENDERED state incl. the trmx-99 flash); lightActive
// consults the override first; the override auto-clears on the NEXT DETECTOR-TRANSITION EVENT —
// every onBusyChange invocation is one by upstream contract (poller change-only, OSC busyChanged-
// guarded), including a fall that finds local state already idle (the missed-rise recovery) —
// and, since trmx-219, on a prompt SUBMIT (Enter while rawBusy) in an interactive/unknown epoch
// (see the trmx-219 describe below). Other non-detector inputs (deadline fires, output, non-submit
// input, classify, plain-epoch/idle-shell Enters) never clear it. isBusy (the trmx-144 close
// guard) never consults it. Phase deadlines are PRESERVED through a toggle —
// applyActivityTransition clears-then-rearms from the returned deadline, so a null mid-phase
// would strand a pendingShow/pendingHide forever.
describe("manual override (trmx-191)", () => {
  it("applies an explicit force regardless of the current light state", () => {
    const idle = initialActivity();
    expect(lightActive(idle, 0)).toBe(false);
    const forcedOn = onManualToggle(idle, "on", 0).state;
    expect(lightActive(forcedOn, 0)).toBe(true);
    expect(lightActive(forcedOn, 60_000)).toBe(true); // steady — no decay under an override

    // A lit plain pane forces off.
    let t = onBusyChange(initialActivity(), true, 0, { name: "sleep" });
    t = onDeadline(t.state, SHOW_DELAY_MS);
    expect(lightActive(t.state, SHOW_DELAY_MS)).toBe(true);
    const forcedOff = onManualToggle(t.state, "off", SHOW_DELAY_MS).state;
    expect(lightActive(forcedOff, SHOW_DELAY_MS)).toBe(false);
  });

  it("auto-clears on the next detector event — rise, fall, AND the missed-rise fall", () => {
    // Force-on over a fresh idle state; a genuine FALL arrives (missed rise — local state was
    // never busy). The override must clear: the escape hatch recovers desync, not survive it.
    const forcedOn = onManualToggle(initialActivity(), "on", 0).state;
    const cleared = onBusyChange(forcedOn, false, 100).state;
    expect(lightActive(cleared, 100)).toBe(false);

    // Force-off over a lit pane; a genuine RISE (fresh epoch) clears the override — the new
    // command's bar shows without further keypresses.
    let t = onBusyChange(initialActivity(), true, 0, { name: "sleep" });
    t = onDeadline(t.state, SHOW_DELAY_MS);
    let s = onManualToggle(t.state, "off", SHOW_DELAY_MS).state;
    s = onBusyChange(s, false, 400).state; // the running job ends (also clears — detector event)
    s = onBusyChange(s, true, 1000, { name: "sleep" }).state; // a NEW command rises
    const shown = onDeadline(s, 1000 + SHOW_DELAY_MS).state;
    expect(lightActive(shown, 1000 + SHOW_DELAY_MS)).toBe(true); // no stale force-off
  });

  it("is NOT cleared by non-submit inputs (deadline, output, keys, classify) or an idle-shell Enter", () => {
    let s = onManualToggle(initialActivity(), "on", 0).state;
    s = onDeadline(s, 5_000).state;
    s = onOutput(s, 4096, 5_100).state;
    s = onInput(s, "x", 5_200).state;
    s = onClassifyMetadata(s, { name: "claude" }, 5_300).state;
    s = onInput(s, "\r", 5_400).state; // Enter at the IDLE shell (not rawBusy) — the launch keystroke
    expect(lightActive(s, 5_500)).toBe(true); // still forced on
  });

  it("never leaks into isBusy — the close guard reads the detector truth only", () => {
    // Forced ON while genuinely idle: the close guard must stay false (no fake-busy prompt).
    const forcedOn = onManualToggle(initialActivity(), "on", 0).state;
    expect(isBusy(forcedOn)).toBe(false);

    // Forced OFF while genuinely busy: the close guard must stay true (still guarded).
    const busy = onBusyChange(initialActivity(), true, 0, { name: "sleep" }).state;
    const forcedOff = onManualToggle(busy, "off", 10).state;
    expect(isBusy(forcedOff)).toBe(true);
  });

  it("preserves the pendingShow deadline — the show still completes under an override", () => {
    const t = onBusyChange(initialActivity(), true, 0, { name: "sleep" });
    expect(t.deadline).toBe(SHOW_DELAY_MS);
    const toggled = onManualToggle(t.state, "off", 50);
    expect(toggled.deadline).toBe(SHOW_DELAY_MS); // the phase timer must be re-armed, not lost
    // The fire still advances the phase (visible) even though the light stays forced off.
    const fired = onDeadline(toggled.state, SHOW_DELAY_MS);
    expect(isVisible(fired.state)).toBe(true);
    expect(lightActive(fired.state, SHOW_DELAY_MS)).toBe(false); // override wins the render
  });

  it("preserves the pendingHide deadline — the linger still ends under an override", () => {
    let t = onBusyChange(initialActivity(), true, 0, { name: "sleep" });
    t = onDeadline(t.state, SHOW_DELAY_MS); // visible
    t = onBusyChange(t.state, false, SHOW_DELAY_MS + 10); // pendingHide (also clears any override)
    const hideAt = t.deadline!;
    const toggled = onManualToggle(t.state, "on", SHOW_DELAY_MS + 20);
    expect(toggled.deadline).toBe(hideAt); // the hide timer survives the toggle
    const fired = onDeadline(toggled.state, hideAt);
    expect(isVisible(fired.state)).toBe(false); // the phase completed its hide
    expect(lightActive(fired.state, hideAt)).toBe(true); // but the light stays forced on
  });
});

// trmx-219: inside an interactive program the detector is SILENT (one long busy epoch — the
// change-only poller says nothing between launch and exit, OSC 133 only fires at the shell
// prompt), so the trmx-191 one-shot can never meet its detector-transition clear and degenerates
// into a session-long pin. The fix: a prompt SUBMIT (Enter while rawBusy, interactive/unknown
// epoch) is that epoch's "next command starts" signal — the override's life ends on the same
// event that opens/renews the activity window. Plain epochs keep the trmx-191 escape hatch
// (an Enter during a stuck long-running command never resurrects a force-hidden bar); output
// never clears (a force-off mid-response must survive the response's own chunks).
describe("override clears on prompt submit (trmx-219)", () => {
  const AI: ActivityMeta = { name: "claude" };

  /** A lit interactive epoch mid-response: rise@0 (claude), show@150, submit@200, output@600. */
  function litInteractive(): ActivityState {
    let s = onDeadline(onBusyChange(initialActivity(), true, 0, AI).state, 150).state;
    s = onInput(s, "\r", 200).state;
    s = onOutput(s, 4096, 600).state;
    return s;
  }

  it("force-off in an interactive epoch: the next submit + output lights again", () => {
    let s = litInteractive();
    expect(lightActive(s, 610)).toBe(true);
    s = onManualToggle(s, "off", 700).state; // silence the current response
    expect(lightActive(s, 710)).toBe(false);
    s = onInput(s, "\r", 1000).state; // the NEXT prompt submit ends the one-shot
    s = onOutput(s, 4096, 1600).state; // response output (past the echo window)
    expect(lightActive(s, 1610)).toBe(true); // lights automatically — no further keypresses
  });

  it("force-on in an interactive epoch: the next submit returns the light to normal decay", () => {
    let s = litInteractive();
    s = onManualToggle(s, "on", 700).state;
    expect(lightActive(s, 60_000)).toBe(true); // pinned — no decay under the override
    s = onInput(s, "\r", 1000).state; // submit hands control back to the heuristic
    expect(lightActive(s, 1010)).toBe(false); // arming alone shows nothing
    s = onOutput(s, 4096, 1600).state;
    expect(lightActive(s, 1610)).toBe(true); // lit while responding
    expect(lightActive(s, 1600 + HOLD_MS + 1)).toBe(false); // and decays after HOLD_MS again
  });

  it("force-off in a plain epoch survives Enter — the stuck-bar escape hatch holds", () => {
    let s = onDeadline(onBusyChange(initialActivity(), true, 0, { name: "sleep" }).state, 150).state;
    expect(lightActive(s, 160)).toBe(true); // plain lights while visible
    s = onManualToggle(s, "off", 200).state;
    s = onInput(s, "\r", 300).state; // an Enter at a stuck long-running command
    expect(s.override).toBe("off"); // override intact
    expect(lightActive(s, 310)).toBe(false);
  });

  it("unknown epoch: a submit clears the override alongside arming pendingSubmit", () => {
    let s = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150).state; // unknown, visible
    s = onManualToggle(s, "on", 200).state;
    s = onInput(s, "\r", 300).state;
    expect(s.pendingSubmit).toBe(true); // the submit is buffered for classification
    expect(s.override).toBeUndefined(); // and the one-shot is spent
    expect(lightActive(s, 310)).toBe(false); // unknown fails dark again
  });
});

describe("isBusy raw readout (trmx-144)", () => {
  it("is false on a fresh idle state", () => {
    expect(isBusy(initialActivity())).toBe(false);
  });

  it("is true during the pre-show window (busy applied, indicator not yet visible)", () => {
    // busy@0 -> pendingShow: the debounced line has NOT appeared (isVisible false), but the pane IS
    // busy RIGHT NOW — a close at t=100 must still be guarded.
    const pending = onBusyChange(initialActivity(), true, 0).state;
    expect(isVisible(pending)).toBe(false);
    expect(isBusy(pending)).toBe(true);
  });

  it("stays true once the line is shown while busy holds", () => {
    const visible = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150).state;
    expect(isVisible(visible)).toBe(true);
    expect(isBusy(visible)).toBe(true);
  });

  it("is false during the min-visible linger (busy dropped, indicator still up)", () => {
    // busy@0 -> shown@150 -> idle@200: pendingHide keeps the LINE up until 450, but the pane is NOT
    // busy anymore — a close during the linger must NOT be guarded.
    const visible = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150).state;
    const lingering = onBusyChange(visible, false, 200).state;
    expect(isVisible(lingering)).toBe(true);
    expect(isBusy(lingering)).toBe(false);
  });

  it("is true again when busy returns during the linger", () => {
    const visible = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150).state;
    const lingering = onBusyChange(visible, false, 200).state;
    const reBusy = onBusyChange(lingering, true, 210).state;
    expect(isBusy(reBusy)).toBe(true);
  });

  it("is false when busy drops before the show delay (never-shown short job)", () => {
    const pending = onBusyChange(initialActivity(), true, 0).state;
    const dropped = onBusyChange(pending, false, 100).state;
    expect(isBusy(dropped)).toBe(false);
  });
});

describe("parseActivityPayload (trmx-91)", () => {
  it("accepts a valid { sessionId, busy } payload (positive session handle)", () => {
    expect(parseActivityPayload({ sessionId: 7, busy: true })).toEqual({ sessionId: 7, busy: true });
    expect(parseActivityPayload({ sessionId: 1, busy: false })).toEqual({ sessionId: 1, busy: false });
  });

  it("rejects a non-positive / unsafe sessionId (review-1: ids start at 1, the isSessionId contract)", () => {
    expect(parseActivityPayload({ sessionId: 0, busy: false })).toBeNull();
    expect(parseActivityPayload({ sessionId: -1, busy: true })).toBeNull();
    expect(parseActivityPayload({ sessionId: Number.MAX_SAFE_INTEGER + 1, busy: true })).toBeNull();
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

  // trmx-159: the optional rise metadata rides the same payload; each field is validated + dropped
  // independently, and absence leaves the payload exactly the trmx-91 { sessionId, busy } shape.
  it("parses the optional foreground metadata into meta", () => {
    expect(
      parseActivityPayload({
        sessionId: 5,
        busy: true,
        foregroundName: "claude",
        foregroundArgs: ["-p", "hi"],
        foregroundStdinTty: true,
      }),
    ).toEqual({
      sessionId: 5,
      busy: true,
      meta: { name: "claude", args: ["-p", "hi"], stdinTty: true },
    });
  });

  it("drops junk metadata fields independently and omits meta entirely when none are present", () => {
    // No metadata at all ⇒ no meta key (exactly the trmx-91 shape).
    expect(parseActivityPayload({ sessionId: 5, busy: true })).toEqual({ sessionId: 5, busy: true });
    // A junk args array (non-string entries) and a junk stdin drop, keeping the valid name.
    expect(
      parseActivityPayload({
        sessionId: 5,
        busy: false,
        foregroundName: "python",
        foregroundArgs: [1, 2],
        foregroundStdinTty: "yes",
      }),
    ).toEqual({ sessionId: 5, busy: false, meta: { name: "python" } });
  });
});

// trmx-159: the classification + activity-window layer on top of the phase debounce. Time is INJECTED
// throughout — the heuristic pins from the issue's test contract, driven with plain numbers.
describe("activity classification + window (trmx-159)", () => {
  const AI: ActivityMeta = { name: "claude" }; // AI CLI, no argv ⇒ interactive (partial-metadata fail-safe)

  /** A visible, born-classified epoch: rise@0 (with meta), show@150. */
  function visibleClassified(meta?: ActivityMeta): ActivityState {
    return onDeadline(onBusyChange(initialActivity(), true, 0, meta).state, 150).state;
  }

  it("keeps the tunables at their documented values", () => {
    expect([HOLD_MS, WINDOW_CLOSE_MS, UNKNOWN_FALLBACK_MS, ECHO_MAX_BYTES]).toEqual([
      3000, 10000, 1500, 2048,
    ]);
  });

  it("an idle interactive program is rawBusy but NOT lit (finding #4: isBusy true, lightActive false)", () => {
    const s = visibleClassified(AI);
    expect(isBusy(s)).toBe(true); // the close guard still fires
    expect(lightActive(s, 160)).toBe(false); // but no line/dot
  });

  it("never lights a launch banner (interactive output before any submit)", () => {
    let s = visibleClassified(AI);
    s = onOutput(s, 4096, 160).state; // banner, window not open ⇒ not counted
    expect(lightActive(s, 170)).toBe(false);
    // A python launch banner is equally dark.
    let p = visibleClassified({ name: "python", args: [] });
    p = onOutput(p, 4096, 160).state;
    expect(lightActive(p, 170)).toBe(false);
  });

  it("lights an interactive epoch on submit+output, then hides after HOLD_MS with no busy event", () => {
    let s = visibleClassified(AI);
    s = onInput(s, "\r", 200).state; // submit opens the window
    expect(lightActive(s, 210)).toBe(false); // arming alone shows nothing
    s = onOutput(s, 4096, 600).state; // real output ⇒ counted
    expect(lightActive(s, 610)).toBe(true);
    expect(lightActive(s, 600 + HOLD_MS)).toBe(true); // still lit at exactly HOLD_MS
    expect(lightActive(s, 600 + HOLD_MS + 1)).toBe(false); // dropped just after — timer-driven, no busy event
  });

  it("buffers an Enter that arrives before classification and honors it on interactive", () => {
    let s = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150).state; // unknown epoch, visible
    s = onInput(s, "\r", 200).state; // Enter while unknown ⇒ buffered
    expect(s.pendingSubmit).toBe(true);
    expect(lightActive(s, 210)).toBe(false); // unknown fails dark
    s = onClassifyMetadata(s, AI, 300).state; // classify interactive ⇒ honor the buffered submit
    expect(s.windowOpen).toBe(true);
    s = onOutput(s, 4096, 400).state;
    expect(lightActive(s, 410)).toBe(true);
  });

  it("falls an unresolved (unknown) epoch back to plain at UNKNOWN_FALLBACK_MS and lights it (pipeline case)", () => {
    let s = onDeadline(onBusyChange(initialActivity(), true, 0).state, 150).state; // unknown, visible
    expect(lightActive(s, 160)).toBe(false); // fail-dark while unknown
    expect(classDeadline(s, 160)).toBe(UNKNOWN_FALLBACK_MS); // the fallback timer
    s = onDeadline(s, UNKNOWN_FALLBACK_MS).state; // the fallback fires
    expect(s.klass).toBe("plain");
    expect(lightActive(s, UNKNOWN_FALLBACK_MS)).toBe(true); // now lit like `true | sleep 30`
  });

  it("isolates the launch Enter: an Enter while idle never arms the next epoch", () => {
    let s = onInput(initialActivity(), "\r", 0).state; // Enter at the idle shell prompt
    expect(s.pendingSubmit).toBe(false);
    s = onBusyChange(s, true, 250, AI).state; // the launched program rises
    expect(s.pendingSubmit).toBe(false); // the launch Enter did not arm the new session
  });

  it("resets the window on in-epoch reclassification (a new program took over the name)", () => {
    let s = visibleClassified(AI);
    s = onInput(s, "\r", 200).state;
    s = onOutput(s, 4096, 600).state;
    expect(lightActive(s, 610)).toBe(true);
    // The foreground name changes to psql (interactive), a mid-epoch takeover ⇒ window resets.
    s = onClassifyMetadata(s, { name: "psql", args: ["mydb"], stdinTty: true }, 700).state;
    expect(s.klass).toBe("interactive");
    expect(s.windowOpen).toBe(false);
    expect(lightActive(s, 710)).toBe(false); // dark until a fresh submit+output
  });

  it("does not re-light after the window closes (post-response repaint is ignored)", () => {
    let s = visibleClassified(AI);
    s = onInput(s, "\r", 200).state;
    s = onOutput(s, 4096, 600).state; // last window activity @600 ⇒ closes @10600
    s = onDeadline(s, 600 + WINDOW_CLOSE_MS).state; // window-close timer fires
    expect(s.windowOpen).toBe(false);
    s = onOutput(s, 4096, 600 + WINDOW_CLOSE_MS + 100).state; // a late repaint
    expect(lightActive(s, 600 + WINDOW_CLOSE_MS + 110)).toBe(false);
  });

  it("self-heals within the window: output after a HOLD gap re-lights, until the window closes", () => {
    let s = visibleClassified(AI);
    s = onInput(s, "\r", 200).state;
    s = onOutput(s, 4096, 600).state;
    expect(lightActive(s, 600 + HOLD_MS + 1)).toBe(false); // dark after the hold gap
    s = onOutput(s, 4096, 5000).state; // still within the 10s window ⇒ counted, re-lights
    expect(lightActive(s, 5010)).toBe(true);
  });

  it("suppresses echo: small output right after a keystroke does not count, a big burst does", () => {
    const base = (() => {
      const s = visibleClassified(AI);
      return onInput(s, "\r", 200).state; // window open, lastInputAt=200
    })();
    // Small (<=2KiB) output 50 ms after the keystroke ⇒ echo ⇒ not counted.
    expect(lightActive(onOutput(base, 10, 250).state, 260)).toBe(false);
    // A >2KiB burst in the same window is real work ⇒ counted.
    expect(lightActive(onOutput(base, 4096, 250).state, 260)).toBe(true);
    // Small output but >300 ms later ⇒ past the echo window ⇒ counted.
    expect(lightActive(onOutput(base, 10, 600).state, 610)).toBe(true);
  });

  it("lights a plain command for its whole run (silent sleep, unlisted name, and one-shot spellings)", () => {
    // An unlisted foreground name ⇒ plain ⇒ lit whenever visible (today's behavior).
    const sleep = visibleClassified({ name: "sleep" });
    expect(lightActive(sleep, 5000)).toBe(true);
    // `python script.py` (a one-shot) ⇒ plain ⇒ lit.
    const oneShot = visibleClassified({ name: "python", args: ["script.py"], stdinTty: true });
    expect(lightActive(oneShot, 5000)).toBe(true);
  });

  it("computes the class deadline for an interactive lit epoch (hold-off then window-close)", () => {
    let s = visibleClassified(AI);
    s = onInput(s, "\r", 200).state;
    s = onOutput(s, 4096, 600).state;
    // While lit, the soonest class deadline is the hold-off (HOLD_MS+1 after last output).
    expect(classDeadline(s, 700)).toBe(600 + HOLD_MS + 1);
    // Past the hold-off (dark, window still open), the soonest is the window-close.
    expect(classDeadline(s, 600 + HOLD_MS + 5)).toBe(600 + WINDOW_CLOSE_MS);
  });
});
