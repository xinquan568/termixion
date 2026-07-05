// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (FR-6): themeTokensToToml — serialize a FULL `ThemeTokens` value into the TOML grammar the
// core's `parse_theme` accepts (crates/termixion-core/tests/fixtures/theme-golden.toml). This backs
// the settings "Duplicate" action: a built-in theme's complete token set becomes a user theme FILE
// that opens as a coherent, editable starting point and round-trips zero-warning. PURE — no DOM /
// clock / randomness — so it is unit-testable headless. Every field is emitted (a Duplicate is
// complete, not minimal), each camelCase token key mapped to the fixture's snake_case
// (isDark→is_dark, errorBg→error_bg, cursorAccent→cursor_accent, selectionBackground→
// selection_background, brightBlack→bright_black … brightWhite→bright_white, activeBorder→
// active_border, inactiveBorder→inactive_border), tables in the fixture's natural reading order, and
// every color string quoted as a TOML basic string.
import type { ThemeTokens } from "./tokens";

/**
 * Quote a color string as a TOML basic string. `JSON.stringify` yields a double-quoted string with
 * TOML-compatible escapes (`\"`, `\\`, control chars) — but our values are plain hex / `rgba(...)`
 * strings, so they pass through verbatim inside the quotes.
 */
function q(value: string): string {
  return JSON.stringify(value);
}

/**
 * Serialize `tokens` to TOML. `sourceLabel` (the built-in this was duplicated from, e.g. "Night")
 * names the origin in the header comment when provided. The output matches theme-golden.toml
 * field-for-field so it parses zero-warning.
 */
export function themeTokensToToml(tokens: ThemeTokens, sourceLabel?: string): string {
  const { color, terminal } = tokens;
  const { ansi } = terminal;
  const lines: string[] = [];

  lines.push(
    sourceLabel
      ? `# Termixion theme — duplicated from ${sourceLabel}; edit freely. See docs/themes.md`
      : `# Termixion theme — edit freely. See docs/themes.md`,
  );
  lines.push("");

  // A top-level scalar MUST precede every table header (once a table opens, bare keys join it).
  lines.push(`is_dark = ${tokens.isDark}`);
  lines.push("");

  lines.push("[color]");
  lines.push(`border = ${q(color.border)}`);
  lines.push(`selection = ${q(color.selection)}`);
  lines.push("");

  lines.push("[color.bg]");
  lines.push(`primary = ${q(color.bg.primary)}`);
  lines.push(`secondary = ${q(color.bg.secondary)}`);
  lines.push(`tertiary = ${q(color.bg.tertiary)}`);
  lines.push("");

  lines.push("[color.text]");
  lines.push(`primary = ${q(color.text.primary)}`);
  lines.push(`secondary = ${q(color.text.secondary)}`);
  lines.push(`tertiary = ${q(color.text.tertiary)}`);
  lines.push("");

  lines.push("[color.accent]");
  lines.push(`primary = ${q(color.accent.primary)}`);
  lines.push(`bg = ${q(color.accent.bg)}`);
  lines.push("");

  lines.push("[color.semantic]");
  lines.push(`error = ${q(color.semantic.error)}`);
  lines.push(`error_bg = ${q(color.semantic.errorBg)}`);
  lines.push(`success = ${q(color.semantic.success)}`);
  lines.push("");

  lines.push("[terminal]");
  lines.push(`cursor = ${q(terminal.cursor)}`);
  lines.push(`cursor_accent = ${q(terminal.cursorAccent)}`);
  lines.push(`selection_background = ${q(terminal.selectionBackground)}`);
  // trmx-90 (sub-task B): the per-pane badge watermark — a single-word `badge` key under [terminal].
  lines.push(`badge = ${q(terminal.badge)}`);
  lines.push("");

  lines.push("[terminal.ansi]");
  lines.push(`black = ${q(ansi.black)}`);
  lines.push(`red = ${q(ansi.red)}`);
  lines.push(`green = ${q(ansi.green)}`);
  lines.push(`yellow = ${q(ansi.yellow)}`);
  lines.push(`blue = ${q(ansi.blue)}`);
  lines.push(`magenta = ${q(ansi.magenta)}`);
  lines.push(`cyan = ${q(ansi.cyan)}`);
  lines.push(`white = ${q(ansi.white)}`);
  lines.push(`bright_black = ${q(ansi.brightBlack)}`);
  lines.push(`bright_red = ${q(ansi.brightRed)}`);
  lines.push(`bright_green = ${q(ansi.brightGreen)}`);
  lines.push(`bright_yellow = ${q(ansi.brightYellow)}`);
  lines.push(`bright_blue = ${q(ansi.brightBlue)}`);
  lines.push(`bright_magenta = ${q(ansi.brightMagenta)}`);
  lines.push(`bright_cyan = ${q(ansi.brightCyan)}`);
  lines.push(`bright_white = ${q(ansi.brightWhite)}`);
  lines.push("");

  lines.push("[terminal.scrollbar]");
  lines.push(`idle = ${q(terminal.scrollbar.idle)}`);
  lines.push(`hover = ${q(terminal.scrollbar.hover)}`);
  lines.push(`active = ${q(terminal.scrollbar.active)}`);
  lines.push("");

  lines.push("[terminal.pane]");
  lines.push(`active_border = ${q(terminal.pane.activeBorder)}`);
  lines.push(`inactive_border = ${q(terminal.pane.inactiveBorder)}`);

  return lines.join("\n") + "\n";
}
