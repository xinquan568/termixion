// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-65 (FR-1.3): the SCROLLBACK slice — capacity and scroll-feel options, distinct from how the
// terminal looks (iterm2Theme.ts / fontSettings.ts) and from VT semantics (emulationOptions.ts).
// trmx-80: FR-13 landed — the capacity is a USER SETTING (terminal.scrollbackLines, clamped by the
// registry to the docs/config.md range) read from the injected store at the realDeps chokepoint,
// and `settings:changed` broadcasts reassign a live terminal's options.scrollback. The buffer-level
// behavior tests still build from these same exports (a test-added option would hide a production
// divergence — the trmx-64 round-2 lesson).
import type { ITerminalOptions } from "@xterm/xterm";
import type { SettingsStore } from "../settings/settingsStore";
import { clampNumberSetting, SETTING_DEFAULTS } from "../settings/settingsStore";

/**
 * The DEFAULT scrollback cap — the registry's value (one source of truth), re-exported for the
 * buffer-level behavior tests (scrollbackBehavior.test.ts). Still an order of magnitude more
 * history than xterm's silent 1000-line default, still cheap in xterm's compact typed-array
 * buffer; since trmx-80 users raise/lower it via terminal.scrollbackLines.
 */
export const SCROLLBACK_LINES = SETTING_DEFAULTS["terminal.scrollbackLines"];

/**
 * Animation duration for DISCRETE scrolls — wheel steps and the built-in Shift+PageUp/PageDown —
 * so they glide instead of teleporting (xterm default 0 = instant). Trackpad two-finger scrolling
 * runs through the same xterm viewport; whether 120 ms hurts its 1:1 directness is only observable
 * in the packaged app, so the PR's manual checklist carries that verification, and the sanctioned
 * fallback (per trmx-65) is to animate only the discrete paths if the packaged feel regresses.
 */
export const SMOOTH_SCROLL_DURATION_MS = 120;

/** The scrollback/scroll-feel option slice for the chokepoint and the behavior tests. */
export function scrollbackTerminalOptions(settings: SettingsStore): ITerminalOptions {
  return {
    scrollback: settings.get("terminal.scrollbackLines"),
    smoothScrollDuration: SMOOTH_SCROLL_DURATION_MS,
  };
}

/** The slice of a live xterm we reassign (xterm resizes the buffer on option assignment). */
export interface ScrollbackOptionsSink {
  options: { scrollback?: number };
}

/**
 * Apply a `settings:changed` payload to a live terminal. Returns true when the payload was a
 * scrollbackLines change and was applied; anything else (other keys, malformed values) is
 * ignored. NOTE: xterm TRUNCATES the buffer when the new cap is smaller than the retained
 * history — shrinking the setting drops the oldest lines immediately. Accepted, documented
 * behavior (FR-13): the alternative (defer until relaunch) would leave the UI lying about the
 * effective cap.
 */
export function applyScrollbackSettingsChange(
  terminal: ScrollbackOptionsSink,
  payload: unknown,
): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const { key, value } = payload as { key?: unknown; value?: unknown };
  // Number.isInteger rejects NaN/±Infinity AND fractional caps (trmx-80 review R4: integers
  // only — the backend refuses them, so a fractional broadcast must never touch the terminal).
  if (key !== "terminal.scrollbackLines" || typeof value !== "number" || !Number.isInteger(value)) {
    return false;
  }
  terminal.options.scrollback = clampNumberSetting("terminal.scrollbackLines", value);
  return true;
}
