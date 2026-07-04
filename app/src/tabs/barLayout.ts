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
// - railGeometryFor: the SINGLE source of the rail's geometry numbers. App writes them as CSS
//   custom properties on the strip container; index.css consumes ONLY the variables.
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

/** The rail-geometry tokens (trmx-82) — the SINGLE geometry source for the tab strip. */
export interface RailGeometry {
  /** The vertical rail's width (irrelevant on horizontal strips — CSS never consumes it there). */
  railWidthPx: number;
  /** A vertical-label tab's height ceiling (natural height by label length up to this). */
  tabMaxHeightPx: number;
  /** A vertical-label tab's height floor. */
  tabMinHeightPx: number;
  /** The close ×'s minimum hit-target square. */
  closeHitTargetMinPx: number;
}

// The trmx-81 status quo, kept as data for totality: the 180px rail, the 34px strip height /
// rail-row min-height, and the 16px close square. Only railWidthPx is CONSUMED outside
// vertical-label mode (the rail's width var); the height/close tokens are inert there — no CSS
// rule outside `.tab-strip--labels-vertical` reads them.
const STATUS_QUO_GEOMETRY: RailGeometry = {
  railWidthPx: 180,
  tabMaxHeightPx: 34,
  tabMinHeightPx: 34,
  closeHitTargetMinPx: 16,
};

// Vertical labels on the vertical rail: a slim 44px rail of tall tabs (60–180px by label length)
// with a ≥24px close hit target at each tab's end.
const VERTICAL_LABEL_GEOMETRY: RailGeometry = {
  railWidthPx: 44,
  tabMaxHeightPx: 180,
  tabMinHeightPx: 60,
  closeHitTargetMinPx: 24,
};

/**
 * The geometry tokens for one strip configuration (trmx-82). Only the exact vertical rail WITH
 * vertical labels gets the narrow-rail tokens; every other combination — horizontal strips (where
 * railWidthPx is irrelevant and stays 180 so the vars are inert), horizontal-label rails, and any
 * junk cast — returns the trmx-81 status quo, so existing layouts are untouched by construction.
 */
export function railGeometryFor(
  orientation: "horizontal" | "vertical",
  labelOrientation: "horizontal" | "vertical",
): RailGeometry {
  return orientation === "vertical" && labelOrientation === "vertical"
    ? VERTICAL_LABEL_GEOMETRY
    : STATUS_QUO_GEOMETRY;
}
