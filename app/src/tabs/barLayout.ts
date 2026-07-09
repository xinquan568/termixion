// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-81 (FR-2.2): the pure tab-bar layout engine. App's JSX order is FIXED — the tab hosts
// first, the strip LAST — so the bar reaches the requested window edge purely by the container's
// flex direction: the LAST child of a `column` sits at the bottom, of a `column-reverse` at the
// top, of a `row` at the right, of a `row-reverse` at the left. Never reorder the JSX instead:
// the keyed hosts' positions (and their keep-alive terminals) must stay untouched by a bar move.
// The strip's own orientation follows the edge — horizontal rows along top/bottom, a vertical
// rail along left/right (TabStrip's `orientation` prop).
//
// trmx-82 (FR-2.3) adds the label-orientation gate and the rail-geometry tokens:
// - labelOrientationFor: the tabs.sideLabelOrientation setting may only take effect on a VERTICAL
//   rail — top/bottom bars force horizontal labels no matter what the setting says.
// - railGeometryFor: the SINGLE source of the VERTICAL-LABEL-MODE geometry numbers. TabStrip
//   writes them as CSS custom properties on its own root in that mode; index.css's
//   `.tab-strip--labels-vertical` rules consume ONLY the variables (no fallbacks). Every other
//   strip layout (horizontal strips, the trmx-81 horizontal-label 180px rail) is a CSS-owned
//   constant — no vars are written or consumed there.
import type { LabelOrientation, TabBarPosition } from "../settings/settingsStore";

/** How App's flex shell lays out for one bar position. */
export interface BarLayout {
  flexDirection: "column" | "column-reverse" | "row" | "row-reverse";
  orientation: "horizontal" | "vertical";
}

/**
 * The layout for `position`. Total over the enum; an out-of-registry value (a junk cast — the
 * registry's parse already falls back before values reach here) gets the bottom default.
 */
export function barLayoutFor(position: TabBarPosition): BarLayout {
  switch (position) {
    case "top":
      return { flexDirection: "column-reverse", orientation: "horizontal" };
    case "right":
      return { flexDirection: "row", orientation: "vertical" };
    case "left":
      return { flexDirection: "row-reverse", orientation: "vertical" };
    case "bottom":
    default:
      return { flexDirection: "column", orientation: "horizontal" };
  }
}

/**
 * The EFFECTIVE label orientation for the strip (trmx-82): "vertical" ONLY when the bar sits on a
 * side edge (barLayoutFor(position).orientation === "vertical") AND the setting opted in.
 * Total over inputs: a junk position cast falls to the bottom layout (horizontal), and anything
 * but the exact "vertical" setting member — including junk casts — is horizontal.
 */
export function labelOrientationFor(
  position: TabBarPosition,
  setting: LabelOrientation,
): "horizontal" | "vertical" {
  return barLayoutFor(position).orientation === "vertical" && setting === "vertical"
    ? "vertical"
    : "horizontal";
}

/** The rail-geometry tokens (trmx-82) — the geometry source for the tab strip's LABEL-LENGTH
 * metrics. trmx-163: the rail WIDTH is no longer here — it is the CSS-owned `--tab-bar-thickness`
 * (28px, equal to the horizontal strip height by construction), so `railWidthPx` is retired.
 * trmx-169: the vertical-label tab HEIGHT is no longer a min/max range here either — it is the
 * fixed CSS length `calc(--tab-length + --tab-close-header)` (index.css), so `tabMin/MaxHeightPx`
 * are retired. This interface now holds only the sub-tab reserved-row / hit-target tokens. */
export interface RailGeometry {
  /** The close ×'s minimum hit-target square. */
  closeHitTargetMinPx: number;
  /** trmx-151: the upright ⌘N hint chip's fixed row on the rotated label (the `--tab-hint-header`
   * var) — 0 outside vertical-label mode (horizontal hints sit inline). trmx-163: the chip now sits
   * at the BOTTOM of the trailing group rather than a top header row, but keeps this reserved row. */
  hintHeaderPx: number;
  /** trmx-165: the reserved TOP row (the `--tab-close-header` var) that hosts the close × in
   * vertical-label mode, so the ×'s hover-reveal never overlaps the rotated title (the title centres
   * in the flexible row below it). 0 outside vertical-label mode — the horizontal strip and the
   * horizontal-label rail overlay the × on the leading edge without a reserved gutter. */
  closeHeaderPx: number;
}

// The trmx-81 status quo, kept as data for totality and REFERENCE ONLY: the 28px strip height /
// rail-row min-height (trmx-163: 34→28, the shared --tab-bar-thickness) and the 16px close square.
// NOTHING consumes it at runtime — index.css hardcodes these numbers as its own constants, and
// TabStrip writes no vars outside vertical-label mode. (The rail width is CSS-owned now — retired.)
const STATUS_QUO_GEOMETRY: RailGeometry = {
  closeHitTargetMinPx: 16,
  hintHeaderPx: 0,
  closeHeaderPx: 0,
};

// Vertical labels on the vertical rail: a ≥24px close hit target. trmx-163: the rail WIDTH is the
// CSS-owned --tab-bar-thickness (28px). trmx-169: the tab HEIGHT is the CSS-owned fixed length
// calc(--tab-length + --tab-close-header) (index.css), no longer a min/max token range here.
// trmx-151 hint header: the upright ⌘N chip occupies a fixed 20px row. trmx-165 close header: a 24px
// reserved TOP row (≥ the close hit target) so the ×'s hover-reveal clears the rotated title.
const VERTICAL_LABEL_GEOMETRY: RailGeometry = {
  closeHitTargetMinPx: 24,
  hintHeaderPx: 20,
  closeHeaderPx: 24,
};

/**
 * The geometry tokens for one strip configuration (trmx-82). This helper OWNS only the
 * vertical-label-mode geometry: the exact vertical rail WITH vertical labels gets the narrow-rail
 * tokens, which TabStrip writes as CSS custom properties on its root and
 * `.tab-strip--labels-vertical` consumes (variables only, no fallbacks).
 *
 * Every other combination — horizontal strips, horizontal-label rails, and any junk cast —
 * returns the trmx-81 status-quo numbers for REFERENCE AND TESTS ONLY; they are not consumed at
 * runtime. The horizontal-label rail width (180px), the vertical-label rail width (the shared
 * --tab-bar-thickness, trmx-163), and the horizontal strip metrics stay CSS-owned constants in
 * index.css, so those layouts are untouched by construction.
 */
export function railGeometryFor(
  orientation: "horizontal" | "vertical",
  labelOrientation: "horizontal" | "vertical",
): RailGeometry {
  return orientation === "vertical" && labelOrientation === "vertical"
    ? VERTICAL_LABEL_GEOMETRY
    : STATUS_QUO_GEOMETRY;
}
