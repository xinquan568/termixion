// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89: deriveTheme — expand a user's `ThemeSpec` (the camelCase JSON the Rust core's `parse_theme`
// emits from a user theme file) into a complete `ThemeTokens` the rest of the app already consumes.
// The spec's REQUIRED set is small — `isDark`, `color.bg.primary`, `color.text.primary`, and the 16
// ANSI colors — and every other token is OPTIONAL: omitted from the JSON when the author didn't set it.
// `deriveTheme` fills EVERY optional deterministically from that required set, so a three-field theme
// file still yields a full, coherent palette. A spec-provided optional always WINS over the derived
// value (author intent beats the formula). Pure + deterministic (no DOM/xterm/React, no clock, no
// randomness), so it is unit-testable headless and safe to run on untrusted user input — the color
// math in ./colorMath never throws (a malformed hex degrades to a passthrough).
import type { AnsiPalette, ThemeTokens } from "./tokens";
import { mix, shade, withAlpha } from "./colorMath";

/**
 * The theme contract as it arrives from the core `parse_theme` (camelCase JSON): required fields are
 * always present; optionals are OMITTED when absent (hence `?`), never `null`; the `accent`,
 * `semantic`, `scrollbar`, and `pane` sub-objects are always present but may be empty (`{}`). This
 * mirrors `ThemeTokens` field-for-field, minus the optionals `deriveTheme` fills in.
 */
export interface ThemeSpec {
  isDark: boolean;
  color: {
    bg: { primary: string; secondary?: string; tertiary?: string };
    text: { primary: string; secondary?: string; tertiary?: string };
    accent: { primary?: string; bg?: string };
    semantic: { error?: string; errorBg?: string; success?: string };
    border?: string;
    selection?: string;
  };
  terminal: {
    ansi: AnsiPalette;
    scrollbar: { idle?: string; hover?: string; active?: string };
    pane: { activeBorder?: string; inactiveBorder?: string };
    /** trmx-98: find-bar highlight colors — OMITTED when the author didn't set them (derived). */
    search?: { match?: string; activeMatch?: string };
    cursor?: string;
    cursorAccent?: string;
    selectionBackground?: string;
    /** trmx-90 (sub-task B): the per-pane badge watermark — OMITTED when the author didn't set it. */
    badge?: string;
  };
}

/** Scrollbar overlay base: white on dark themes, black on light — tinted at the idle/hover/active alphas. */
const scrollbarBase = (isDark: boolean): string => (isDark ? "#ffffff" : "#000000");

/**
 * Derive a full `ThemeTokens` from a (possibly minimal) `ThemeSpec`. Every optional is resolved as
 * `spec value ?? formula`, so an author-provided value wins and an omitted one is filled. The
 * derivation order matters for the fields that build on other resolved fields: `accent.primary` and
 * `border` are resolved first because `accent.bg`, `selection`, `pane.activeBorder`, and
 * `pane.inactiveBorder` are derived from them.
 */
export function deriveTheme(spec: ThemeSpec): ThemeTokens {
  const { isDark } = spec;
  const bgPrimary = spec.color.bg.primary;
  const textPrimary = spec.color.text.primary;
  const { ansi } = spec.terminal;

  // Resolved-first: everything below may reference these.
  const accentPrimary = spec.color.accent.primary ?? ansi.blue;
  const border = spec.color.border ?? mix(bgPrimary, textPrimary, 0.18);
  const base = scrollbarBase(isDark);

  return {
    isDark,
    color: {
      bg: {
        primary: bgPrimary,
        secondary: spec.color.bg.secondary ?? shade(bgPrimary, isDark ? 4 : -4),
        tertiary: spec.color.bg.tertiary ?? shade(bgPrimary, isDark ? 8 : -8),
      },
      text: {
        primary: textPrimary,
        secondary: spec.color.text.secondary ?? mix(textPrimary, bgPrimary, 0.3),
        tertiary: spec.color.text.tertiary ?? mix(textPrimary, bgPrimary, 0.55),
      },
      accent: {
        primary: accentPrimary,
        bg: spec.color.accent.bg ?? withAlpha(accentPrimary, 0.12),
      },
      border,
      selection: spec.color.selection ?? withAlpha(accentPrimary, 0.22),
      semantic: {
        error: spec.color.semantic.error ?? ansi.red,
        errorBg: spec.color.semantic.errorBg ?? withAlpha(ansi.red, 0.15),
        success: spec.color.semantic.success ?? ansi.green,
      },
    },
    terminal: {
      // Fresh copy so the derived tokens never alias the caller's ansi object.
      ansi: { ...ansi },
      cursor: spec.terminal.cursor ?? textPrimary,
      cursorAccent: spec.terminal.cursorAccent ?? bgPrimary,
      selectionBackground: spec.terminal.selectionBackground ?? withAlpha(accentPrimary, 0.22),
      // trmx-90 (sub-task B): a subtle per-pane watermark. Default = text.primary at 0.12 alpha (a
      // faint tint that reads without harming legibility); a spec-provided badge wins.
      badge: spec.terminal.badge ?? withAlpha(textPrimary, 0.12),
      scrollbar: {
        idle: spec.terminal.scrollbar.idle ?? withAlpha(base, 0.12),
        hover: spec.terminal.scrollbar.hover ?? withAlpha(base, 0.2),
        active: spec.terminal.scrollbar.active ?? withAlpha(base, 0.3),
      },
      pane: {
        activeBorder: spec.terminal.pane.activeBorder ?? accentPrimary,
        inactiveBorder: spec.terminal.pane.inactiveBorder ?? border,
      },
      // trmx-98 (FR-1.5): find-bar highlights. Default = the theme's yellow at low alpha for matches, a
      // stronger warm tint for the active one — translucent so cell text stays legible; a spec value wins.
      search: {
        match: spec.terminal.search?.match ?? withAlpha(ansi.yellow, 0.28),
        activeMatch: spec.terminal.search?.activeMatch ?? withAlpha(ansi.yellow, 0.45),
      },
    },
  };
}
