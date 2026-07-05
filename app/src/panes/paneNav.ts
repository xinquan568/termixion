// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-86 (FR-3.5): pure keyboard pane navigation — directional (`paneInDirection`, the geometrically
// nearest pane in a direction) and cyclic (`nextPane`, over the stable `leaves()` order). Pure +
// React-free like layoutTree.ts, so the geometry is unit-testable headless and the FR-9 keyboard
// commands (v0.0.8) can call the same functions. Consumes the trmx-84 seams: `solveRects` pane rects
// (directional) and `leaves` (cyclic). No wrap on directional (edges are no-ops); wrap on cyclic.

import { leaves, type LayoutNode, type PaneId, type PaneRect, type Rect } from "./layoutTree";

export type Direction = "left" | "right" | "up" | "down";

// Overlap (px) of two rects projected onto one axis; > 0 means they share a span on that axis.
function overlap(a: Rect, b: Rect, axis: "x" | "y"): number {
  if (axis === "x") return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
}

/**
 * The geometrically nearest pane in `dir` from `fromPaneId`, or null (NO wrap — an edge is a no-op). A
 * candidate qualifies if its near edge lies in `dir` (`≥/≤` absorbs the 1px divider gap) AND it overlaps
 * the source in the perpendicular axis. Ranked by: (1) smallest edge distance, (2) largest perpendicular
 * overlap, (3) topmost-then-leftmost — a total, deterministic order. Unknown `fromPaneId` → null.
 */
export function paneInDirection(
  panes: PaneRect[],
  fromPaneId: PaneId,
  dir: Direction,
): PaneId | null {
  const from = panes.find((p) => p.paneId === fromPaneId);
  if (!from) return null;
  const f = from.rect;
  type Scored = { paneId: PaneId; dist: number; ov: number; y: number; x: number };
  const scored: Scored[] = [];
  for (const p of panes) {
    if (p.paneId === fromPaneId) continue;
    const c = p.rect;
    let dist: number;
    let ov: number;
    if (dir === "right") {
      if (c.x < f.x + f.width) continue; // not to the right
      dist = c.x - (f.x + f.width);
      ov = overlap(f, c, "y");
    } else if (dir === "left") {
      if (c.x + c.width > f.x) continue;
      dist = f.x - (c.x + c.width);
      ov = overlap(f, c, "y");
    } else if (dir === "down") {
      if (c.y < f.y + f.height) continue;
      dist = c.y - (f.y + f.height);
      ov = overlap(f, c, "x");
    } else {
      if (c.y + c.height > f.y) continue;
      dist = f.y - (c.y + c.height);
      ov = overlap(f, c, "x");
    }
    if (ov <= 0) continue; // must share a perpendicular span
    scored.push({ paneId: p.paneId, dist, ov, y: c.y, x: c.x });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.dist - b.dist || b.ov - a.ov || a.y - b.y || a.x - b.x);
  return scored[0].paneId;
}

/**
 * The next (`+1`) or previous (`-1`) pane in the stable `leaves(tree)` order, WRAPPING at the ends. Null
 * only if `fromPaneId` isn't in the tree; a single-pane tree returns that same pane (App treats a target
 * equal to the current focus as a no-op).
 */
export function nextPane(tree: LayoutNode, fromPaneId: PaneId, delta: 1 | -1): PaneId | null {
  const order = leaves(tree);
  const i = order.indexOf(fromPaneId);
  if (i === -1) return null;
  const n = order.length;
  return order[(i + delta + n) % n];
}
