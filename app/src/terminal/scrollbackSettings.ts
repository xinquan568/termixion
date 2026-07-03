// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-65 (FR-1.3): the SCROLLBACK slice — capacity and scroll-feel options, distinct from how the
// terminal looks (iterm2Theme.ts) and from VT semantics (emulationOptions.ts). Pure record, no
// runtime imports; fed to `new Terminal(...)` at the realDeps chokepoint and to the buffer-level
// behavior tests, which build from this same export (a test-added option would hide a production
// divergence — the trmx-64 round-2 lesson).
import type { ITerminalOptions } from "@xterm/xterm";

/**
 * The scrollback cap, OUR constant instead of xterm's silent 1000-line default: an order of
 * magnitude more history for daily work, still cheap in xterm's compact typed-array buffer (tens of
 * MB worst case at very wide grids). FR-13 (v0.0.5) turns this into a user setting; until then it
 * is fixed here and pinned at the chokepoint (realDeps.test.ts) and by scrollbackBehavior.test.ts.
 */
export const SCROLLBACK_LINES = 10_000;

/**
 * Animation duration for DISCRETE scrolls — wheel steps and the built-in Shift+PageUp/PageDown —
 * so they glide instead of teleporting (xterm default 0 = instant). Trackpad two-finger scrolling
 * runs through the same xterm viewport; whether 120 ms hurts its 1:1 directness is only observable
 * in the packaged app, so the PR's manual checklist carries that verification, and the sanctioned
 * fallback (per trmx-65) is to animate only the discrete paths if the packaged feel regresses.
 */
export const SMOOTH_SCROLL_DURATION_MS = 120;

/** The scrollback/scroll-feel option slice for the chokepoint and the behavior tests. */
export function scrollbackTerminalOptions(): ITerminalOptions {
  return {
    scrollback: SCROLLBACK_LINES,
    smoothScrollDuration: SMOOTH_SCROLL_DURATION_MS,
  };
}
