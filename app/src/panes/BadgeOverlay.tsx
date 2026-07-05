// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-90 (sub-task F): the per-pane BADGE OVERLAY — iTerm2's translucent corner watermark. An
// absolutely-positioned, click-through (pointer-events: none) label pinned to the pane's TOP-RIGHT,
// painted in the active theme's `terminal.badge` tint, large + bold so it reads as identity behind
// the glyphs without competing with them. Rendered per pane from the pane's `badge` state; renders
// NOTHING (returns null) when the pane has no badge OR is too narrow (badgeVisible). It honors
// embedded `\n` (a badge may be multi-line, per the OSC 1337 sanitizer) but clamps to 2 lines with an
// ellipsis and caps its width (~50% of the pane, in CSS) so a long badge never sprawls across the pane.
//
// Styling split (the scrollbar idiom): the STATIC look (corner inset, weight, 2-line clamp, max-width,
// pre-line wrapping) lives in the `.tx-badge` CSS class (index.css); the DYNAMIC bits — the theme
// color and the ~2×-cell-height font size — are inline. `pointer-events: none` is ALSO set inline: it
// is the load-bearing click-through guarantee, and jsdom (css:false under Vitest) can only assert it
// off the inline style. z-order sits BELOW the scrollbar (z-index 10) and ABOVE the xterm screen —
// see the `.tx-badge` rule in index.css.
import { badgeVisible } from "./badgeVisible";

/** ~2× the cell height: the large watermark scale (iTerm2-ish). */
const BADGE_FONT_SCALE = 2;
/** Font size (px) when the cell height is not yet known (pre-fit) but the badge must still show. */
const FALLBACK_FONT_PX = 28;

export interface BadgeOverlayProps {
  /** The pane's badge label (undefined / empty = no badge → nothing renders). */
  badge: string | undefined;
  /** The pane's current width in CELLS (the terminal's `cols`) — drives the narrow-pane threshold. */
  cellsWide: number;
  /** The pane's cell height in px — the badge font is ~2× this (falls back when unknown / zero). */
  cellHeightPx: number;
  /** The active theme's `terminal.badge` tint (resolveTheme(id).terminal.badge). */
  color: string;
}

/**
 * The pane's badge watermark, or `null` when it must not show (no badge / too-narrow pane). Purely
 * presentational — App threads the pane's `badge`, its live cell metrics, and the theme color.
 */
export function BadgeOverlay({ badge, cellsWide, cellHeightPx, color }: BadgeOverlayProps) {
  const hasBadge = typeof badge === "string" && badge.length > 0;
  if (!badgeVisible(cellsWide, hasBadge)) return null;

  const fontSizePx =
    Number.isFinite(cellHeightPx) && cellHeightPx > 0
      ? Math.round(BADGE_FONT_SCALE * cellHeightPx)
      : FALLBACK_FONT_PX;

  return (
    <div
      className="tx-badge"
      data-testid="pane-badge"
      aria-hidden="true"
      style={{
        color,
        fontSize: `${fontSizePx}px`,
        // Load-bearing + jsdom-assertable: the overlay never intercepts the terminal's own clicks.
        pointerEvents: "none",
      }}
    >
      {badge}
    </div>
  );
}
