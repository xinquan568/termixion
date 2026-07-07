// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-149: iTerm2's badge FIT-TO-BOX sizing model, ported exactly. iTerm2 sizes its badge to the
// LARGEST font whose rendered label fits a 2D box with INDEPENDENT constraints — width ≤ 0.5 × pane
// width AND height ≤ 0.2 × pane height (iTermAdvancedSettingsModel.m:794-795, badgeMaxWidthFraction
// / badgeMaxHeightFraction) — found by an integer binary search between a 4pt floor and a 100pt
// ceiling (iTermBadgeLabel.m:28-31 minimum/maximumPointSize; :143-181 idealPointSize). This module
// is that search plus the measurement seam it drives: `fitBadgeFontPx` is PURE (measurement is
// injected as a `BadgeMeasure`, so it is unit-testable with a deterministic fake and jsdom-safe),
// while `makeCanvasBadgeMeasure` is the real browser measurer — an offscreen canvas 2d context
// measuring bold Helvetica (iTerm2's badgeFont + badgeFontIsBold, iTermAdvancedSettingsModel.m:
// 792-793), honoring the `.tx-badge` 2-line clamp and 1.05 line-height. It returns null where a 2d
// context is unavailable (jsdom!), and BadgeOverlay falls back to FALLBACK_FONT_PX.

/** Measures the badge label at a candidate font size → its rendered box (px). Injectable seam. */
export type BadgeMeasure = (text: string, fontPx: number) => { width: number; height: number };

/**
 * The badge font stack — Helvetica first (iTerm2's default badgeFont, rendered bold per
 * badgeFontIsBold), with metric-compatible fallbacks for non-mac platforms. The SINGLE source for
 * both the canvas measurer's font string and the `.tx-badge` CSS rule (index.css mirrors this
 * token list verbatim — the CSS contract test in BadgeOverlay.test.tsx pins the mirror), so the
 * measured font is always the painted font.
 */
export const BADGE_FONT_FAMILY = 'Helvetica, "Helvetica Neue", Arial, "Liberation Sans", sans-serif';

/** Font size (px) when the fit cannot run (no measurer / unknown geometry / empty label). */
export const FALLBACK_FONT_PX = 28;

/** iTerm2's point-size floor for the search (iTermBadgeLabel.m:30, minimumPointSize). */
const MIN_FONT_PX = 4;
/** iTerm2's point-size ceiling (iTermBadgeLabel.m:31, maximumPointSize). The integer midpoint
 * loop never probes the ceiling itself, so an unconstrained fit converges at 99 — exact parity. */
const MAX_FONT_PX = 100;

/** Max badge width as a fraction of the pane (iTermAdvancedSettingsModel.m:794). */
const MAX_WIDTH_FRACTION = 0.5;
/** Max badge height as a fraction of the pane (iTermAdvancedSettingsModel.m:795). */
const MAX_HEIGHT_FRACTION = 0.2;

/** Lines the measurer considers — the `.tx-badge` -webkit-line-clamp (index.css). */
const MAX_MEASURED_LINES = 2;
/** The `.tx-badge` line-height; a measured line is this × the font size tall. */
const LINE_HEIGHT = 1.05;

/**
 * The largest font size (px, integer) at which `label` fits the pane's badge box — iTerm2's
 * idealPointSize binary search, verbatim (iTermBadgeLabel.m:155-181): probe the integer midpoint;
 * a probe EXCEEDING either constraint pulls the ceiling down, one STRICTLY UNDER both pushes the
 * floor up (an exact-boundary probe moves neither — the loop still terminates because the midpoint
 * repeats), until the midpoint stops moving. Degenerate inputs (empty label, non-finite or
 * non-positive pane dims) skip the search → {@link FALLBACK_FONT_PX}.
 */
export function fitBadgeFontPx(
  label: string,
  paneWidthPx: number,
  paneHeightPx: number,
  measure: BadgeMeasure,
): number {
  if (label.length === 0) return FALLBACK_FONT_PX;
  if (!Number.isFinite(paneWidthPx) || paneWidthPx <= 0) return FALLBACK_FONT_PX;
  if (!Number.isFinite(paneHeightPx) || paneHeightPx <= 0) return FALLBACK_FONT_PX;

  const maxWidth = paneWidthPx * MAX_WIDTH_FRACTION;
  const maxHeight = paneHeightPx * MAX_HEIGHT_FRACTION;

  // iTermBadgeLabel.m:160-179 — `int points = (min + max) / 2` (C float→int truncation = floor
  // for these positive values), looped until the midpoint repeats.
  let min = MIN_FONT_PX;
  let max = MAX_FONT_PX;
  let points = Math.floor((min + max) / 2);
  let prevPoints = -1;
  while (points !== prevPoints) {
    const size = measure(label, points);
    if (size.width > maxWidth || size.height > maxHeight) {
      max = points;
    } else if (size.width < maxWidth && size.height < maxHeight) {
      min = points;
    }
    prevPoints = points;
    points = Math.floor((min + max) / 2);
  }
  return points;
}

/**
 * The REAL {@link BadgeMeasure}: an offscreen canvas 2d context measuring the label in bold
 * {@link BADGE_FONT_FAMILY} (exactly what `.tx-badge` paints). Width is the WIDEST of the first
 * {@link MAX_MEASURED_LINES} lines (the CSS clamp hides the rest — they must not shrink the fit);
 * height is lineCount × fontPx × {@link LINE_HEIGHT}. Returns null when no 2d context exists
 * (jsdom under Vitest) — callers fall back to {@link FALLBACK_FONT_PX}.
 */
export function makeCanvasBadgeMeasure(): BadgeMeasure | null {
  if (typeof document === "undefined") return null;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  return (text, fontPx) => {
    const lines = text.split("\n").slice(0, MAX_MEASURED_LINES);
    ctx.font = `bold ${fontPx}px ${BADGE_FONT_FAMILY}`;
    let width = 0;
    for (const line of lines) {
      width = Math.max(width, ctx.measureText(line).width);
    }
    return { width, height: lines.length * fontPx * LINE_HEIGHT };
  };
}
