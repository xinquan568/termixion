// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-80 (FR-13): the FONT slice of the terminal's effective options. iterm2Theme stays the
// untouched record of iTerm2-profile facts (SF Mono stack at 12 pt); the registry's
// terminal.fontFamily / terminal.fontSize overlay them at the display chokepoint
// (realDeps.createTerminal — the slice spreads AFTER iterm2TerminalOptions so a persisted font
// wins). An empty/whitespace fontFamily means "use the platform default stack"
// (ITERM2_FONT_FAMILY). The same module applies `settings:changed` broadcasts to a live terminal;
// a font change alters the grid METRICS, so the caller must re-fit and recompute the scrollbar
// after an applied change (TerminalView does). Pure + payload-guarded: events are untrusted
// input, junk must be inert.
import type { SettingsStore } from "../settings/settingsStore";
import { clampNumberSetting } from "../settings/settingsStore";
import { fontStackFor } from "./fontCatalog";

export interface FontTerminalOptions {
  fontFamily: string;
  fontSize: number;
}

/**
 * Resolve the registry's fontFamily: ""/whitespace = the platform default stack; a trmx-204
 * bundled family = family-first with the platform stack appended; anything else verbatim.
 */
function resolveFontFamily(family: string): string {
  return fontStackFor(family);
}

/** The persisted (or default: platform stack at 12 pt) font options for construction. */
export function fontTerminalOptions(settings: SettingsStore): FontTerminalOptions {
  return {
    fontFamily: resolveFontFamily(settings.get("terminal.fontFamily")),
    // Already clamped by the registry (SETTING_RANGES) on every read path.
    fontSize: settings.get("terminal.fontSize"),
  };
}

/** The slice of a live xterm we reassign (xterm re-measures and repaints on option assignment). */
export interface FontOptionsSink {
  options: { fontFamily?: string; fontSize?: number };
}

/**
 * Apply a `settings:changed` payload to a live terminal. Returns true ONLY when the payload was a
 * font setting and was applied — the caller then re-fits the grid and recomputes the scrollbar
 * (font changes alter the cell metrics). Anything else (other keys, malformed values) is ignored.
 */
export function applyFontSettingsChange(terminal: FontOptionsSink, payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const { key, value } = payload as { key?: unknown; value?: unknown };
  if (key === "terminal.fontFamily" && typeof value === "string") {
    terminal.options.fontFamily = resolveFontFamily(value);
    return true;
  }
  // Number.isInteger rejects NaN/±Infinity AND fractional sizes (trmx-80 review R4: integers
  // only — the backend refuses them, so a fractional broadcast must never touch the terminal).
  if (key === "terminal.fontSize" && typeof value === "number" && Number.isInteger(value)) {
    terminal.options.fontSize = clampNumberSetting("terminal.fontSize", value);
    return true;
  }
  return false;
}
