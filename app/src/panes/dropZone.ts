// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-100 (FR-3.4): the five-zone drop hit-test. A pointer over a target pane maps to one of four edge
// zones (dock left/right/top/bottom) or the center (swap). Pure geometry over the target's solved rect;
// App composes the ACTIONABLE target — a `center` always swaps, an edge is offered only when `canDropEdge`
// says the 50/50 insert keeps both halves above the min-size floor (else the drop is refused, target null).

import type { DropEdge, Rect } from "./layoutTree";

export type DropZone = DropEdge | "center";

/** Half-width of the central swap square, as a fraction of the rect from center (0.2 → inner 40%). */
const CENTER_HALF = 0.2;

/**
 * Which drop zone the `pointer` falls in over `rect`. A central square (inner 40%) is `center` (swap);
 * otherwise the dominant axis from center picks an edge — `|dx| >= |dy|` → left/right, else top/bottom
 * (so a perfect corner resolves to the horizontal edge, deterministically). A pointer outside the rect
 * clamps in (App only calls this for the hovered pane).
 */
export function dropZone(rect: Rect, pointer: { x: number; y: number }): DropZone {
  const fx = rect.width > 0 ? clamp01((pointer.x - rect.x) / rect.width) : 0.5;
  const fy = rect.height > 0 ? clamp01((pointer.y - rect.y) / rect.height) : 0.5;
  const dx = fx - 0.5;
  const dy = fy - 0.5;
  if (Math.abs(dx) <= CENTER_HALF && Math.abs(dy) <= CENTER_HALF) return "center";
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "top" : "bottom";
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
