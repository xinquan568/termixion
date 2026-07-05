// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-87 (FR-3.6): the pure "which dividers are active" computation for the Kitty multi-pane look. A
// divider is ACTIVE (drawn in the focused-pane border color) when it BOUNDS the focused pane — i.e. it
// is edge-adjacent to the focused pane's rect and overlaps it in the perpendicular axis. In our flat,
// non-segmented divider model a whole divider is active if it touches the focused pane (Kitty segments
// borders; this is the faithful approximation). Pure + React-free like layoutTree/paneNav so it is
// unit-testable headless; App turns the result into a class flip (no re-layout, no terminal touch).

import type { DividerRect, PaneId, PaneRect, Rect } from "./layoutTree";

/** The stable key App renders for a divider (its `divider-${key}` React key + data-testid base). */
export function dividerKey(path: DividerRect["path"]): string {
  return path.join("-") || "root";
}

// Perpendicular-axis overlap (px) of two rects; > 0 means they share a span on that axis.
function overlap(a: Rect, b: Rect, axis: "x" | "y"): number {
  if (axis === "x") return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
}

// Does divider `d` bound (touch an edge of) the focused rect `f`, sharing a perpendicular span?
function bounds(f: Rect, d: DividerRect): boolean {
  if (d.dir === "row") {
    // Vertical divider: adjacent to the focused pane's left OR right edge.
    const adjacent = d.rect.x + d.rect.width === f.x || d.rect.x === f.x + f.width;
    return adjacent && overlap(f, d.rect, "y") > 0;
  }
  // Horizontal divider: adjacent to the focused pane's top OR bottom edge.
  const adjacent = d.rect.y + d.rect.height === f.y || d.rect.y === f.y + f.height;
  return adjacent && overlap(f, d.rect, "x") > 0;
}

/**
 * The keys of the dividers that OUTLINE the focused pane (active border). Empty for an unknown focus or
 * a single-pane tab (which has no dividers). App draws these in `--tx-pane-active-border`, the rest in
 * `--tx-pane-inactive-border`.
 */
export function activeDividerKeys(
  panes: PaneRect[],
  dividers: DividerRect[],
  focusedPaneId: PaneId,
): Set<string> {
  const focused = panes.find((p) => p.paneId === focusedPaneId);
  const out = new Set<string>();
  if (!focused) return out;
  for (const d of dividers) {
    if (bounds(focused.rect, d)) out.add(dividerKey(d.path));
  }
  return out;
}
