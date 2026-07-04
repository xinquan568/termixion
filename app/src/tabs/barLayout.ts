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
import type { TabBarPosition } from "../settings/settingsStore";

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
