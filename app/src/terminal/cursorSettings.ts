// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the cursor slice of the terminal's effective options. iterm2Theme stays the untouched
// record of iTerm2-profile facts (block, non-blinking); the ISSUE's defaults — Underline, blink on
// — live in the settings registry and are overlaid at the display chokepoint
// (realDeps.createTerminal), a conscious supersession of the trmx-44 cursor defaults. The same
// module applies `settings:changed` broadcasts to a live terminal, so a change made in the
// settings window (or a reset's default-value broadcast) takes effect immediately. Pure + payload-
// guarded: events are untrusted input, junk must be inert.
import type { CursorStyle, SettingsStore } from "../settings/settingsStore";

export interface CursorTerminalOptions {
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
}

/** The persisted (or default: underline, blink on) cursor options for terminal construction. */
export function cursorTerminalOptions(settings: SettingsStore): CursorTerminalOptions {
  return {
    cursorStyle: settings.get("terminal.cursorStyle"),
    cursorBlink: settings.get("terminal.cursorBlink"),
  };
}

/** The slice of a live xterm we reassign (xterm applies option assignment without a remount). */
export interface CursorOptionsSink {
  options: { cursorStyle?: CursorStyle; cursorBlink?: boolean };
}

const CURSOR_STYLES: ReadonlyArray<CursorStyle> = ["bar", "block", "underline"];

/**
 * Apply a `settings:changed` payload to a live terminal. Returns true when the payload was a
 * cursor setting and was applied; anything else (other keys, malformed values) is ignored.
 */
export function applyCursorSettingsChange(terminal: CursorOptionsSink, payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const { key, value } = payload as { key?: unknown; value?: unknown };
  if (key === "terminal.cursorStyle" && CURSOR_STYLES.includes(value as CursorStyle)) {
    terminal.options.cursorStyle = value as CursorStyle;
    return true;
  }
  if (key === "terminal.cursorBlink" && typeof value === "boolean") {
    terminal.options.cursorBlink = value;
    return true;
  }
  return false;
}
