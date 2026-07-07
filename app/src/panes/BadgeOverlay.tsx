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
// trmx-149: iTerm2 fit-to-box parity. The font size is no longer ~2× the cell height — it is the
// LARGEST size whose measured label fits width ≤ 0.5 × pane width AND height ≤ 0.2 × pane height,
// via iTerm2's integer binary search (badgeFit.ts, ported from iTermBadgeLabel.m idealPointSize).
// The measurer seam is injectable (`measure` prop) for deterministic tests; the default is a
// module-lazy canvas measurer, which is null under jsdom → FALLBACK_FONT_PX. The glyphs also get an
// edge stroke in the theme BACKGROUND color at ~2% of the font size (AppKit's
// NSStrokeWidthAttributeName @-2 idiom, floored at 0.5px) so the watermark separates from same-tint
// content beneath it.
//
// Styling split (the scrollbar idiom): the STATIC look (corner inset, weight, 2-line clamp, max-width,
// pre-line wrapping) lives in the `.tx-badge` CSS class (index.css); the DYNAMIC bits — the theme
// color, the fitted font size, and the background-tinted stroke — are inline. `pointer-events: none`
// is ALSO set inline: it is the load-bearing click-through guarantee, and jsdom (css:false under
// Vitest) can only assert it off the inline style. z-order sits BELOW the scrollbar (z-index 10) and
// ABOVE the xterm screen — see the `.tx-badge` rule in index.css.
import { useMemo } from "react";
import { badgeVisible } from "./badgeVisible";
import {
  FALLBACK_FONT_PX,
  fitBadgeFontPx,
  makeCanvasBadgeMeasure,
  type BadgeMeasure,
} from "./badgeFit";

// The default measurer, created LAZILY once per module (a canvas context is not free, and module
// evaluation must not touch the DOM — App imports this file in environments that render nothing).
// `undefined` = not yet attempted; `null` = attempted, no 2d context (jsdom) → fallback size.
let defaultMeasure: BadgeMeasure | null | undefined;
function getDefaultMeasure(): BadgeMeasure | null {
  if (defaultMeasure === undefined) defaultMeasure = makeCanvasBadgeMeasure();
  return defaultMeasure;
}

export interface BadgeOverlayProps {
  /** The pane's badge label (undefined / empty = no badge → nothing renders). */
  badge: string | undefined;
  /** The pane's current width in CELLS (the terminal's `cols`) — drives the narrow-pane threshold. */
  cellsWide: number;
  /** The pane's width in px — the fit box is 0.5 × this (iTerm2 badgeMaxWidthFraction). */
  paneWidthPx: number;
  /** The pane's height in px — the fit box is 0.2 × this (iTerm2 badgeMaxHeightFraction). */
  paneHeightPx: number;
  /** The active theme's `terminal.badge` tint (resolveTheme(id).terminal.badge). */
  color: string;
  /** The active theme's BACKGROUND (color.bg.primary) — tints the glyph-edge stroke. */
  outlineColor: string;
  /** Measurement seam for the fit (tests inject a fake); default: the lazy canvas measurer. */
  measure?: BadgeMeasure;
}

/**
 * The pane's badge watermark, or `null` when it must not show (no badge / too-narrow pane). Purely
 * presentational — App threads the pane's `badge`, its pane-rect geometry, and the theme colors.
 */
export function BadgeOverlay({
  badge,
  cellsWide,
  paneWidthPx,
  paneHeightPx,
  color,
  outlineColor,
  measure,
}: BadgeOverlayProps) {
  const hasBadge = typeof badge === "string" && badge.length > 0;
  const m = measure !== undefined ? measure : getDefaultMeasure();

  // The iTerm2 fit, re-run only when the label or the pane geometry moves. No measurer (jsdom) or
  // degenerate geometry → the fallback size (fitBadgeFontPx also self-guards the geometry).
  const fontSizePx = useMemo(() => {
    if (!hasBadge || m === null) return FALLBACK_FONT_PX;
    return fitBadgeFontPx(badge as string, paneWidthPx, paneHeightPx, m);
  }, [hasBadge, badge, paneWidthPx, paneHeightPx, m]);

  if (!badgeVisible(cellsWide, hasBadge)) return null;

  return (
    <div
      className="tx-badge"
      data-testid="pane-badge"
      aria-hidden="true"
      style={{
        color,
        fontSize: `${fontSizePx}px`,
        // trmx-149: the glyph edge — ~2% of the font size (AppKit @-2), floored so it never
        // vanishes, in the theme background so the badge separates from same-tint glyphs below.
        WebkitTextStroke: `${Math.max(0.5, 0.02 * fontSizePx)}px ${outlineColor}`,
        // Load-bearing + jsdom-assertable: the overlay never intercepts the terminal's own clicks.
        pointerEvents: "none",
      }}
    >
      {badge}
    </div>
  );
}
