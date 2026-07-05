// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-85 (FR-3.3): the pure divider-drag math. Given a pointer position along a split's main axis and
// the split's ENCLOSING rect (layoutTree's DividerRect.bounds), produce the new clamped `ratio` for that
// split. Pure + React-free (like layoutTree.ts), so the drag math is unit-testable headless and the
// FR-9 keyboard commands (v0.0.8) can reuse the same setRatio/setPaneRatio seam without touching this.
//
// Two correctness invariants (both flagged in review):
// 1. SOLVER-MATCHED DENOMINATOR. solveRects lays a split out as `gap = min(dividerPx, mainLen);
//    available = mainLen - gap; firstMain = round(available * ratio)`, so the divider's leading edge is
//    at `mainStart + firstMain`. This module inverts THAT: `ratio = (leadingEdge - mainStart) / available`
//    with `available = mainLen - min(dividerPx, mainLen)` — never the full enclosing length, or the min
//    clamp is off by a pixel and the divider drifts from the cursor.
// 2. GRAB OFFSET (no jump). The divider has a widened (~7px) hit area over a 1px line, so pointerdown
//    usually lands beside the line. The caller records `grabOffset = pointerMain - dividerLeadingEdge`
//    at pointerdown; here `leadingEdge = pointerMain - grabOffset` keeps the grabbed point under the
//    cursor, so the divider does not snap to the pointer on the first move.

import {
  DEFAULT_DIVIDER_PX,
  MIN_PANE_PX,
  MIN_RATIO,
  type MinSize,
  type Rect,
  type SplitDir,
} from "./layoutTree";

/** The ratio a double-click resets a split to. */
export const RESET_RATIO = 0.5;

/** Inputs to the pointer→ratio map. `dividerPx`/`min` default to the solver/engine constants. */
export interface DragInput {
  /** Pointer coordinate along the split's main axis (clientX for a row split, clientY for column). */
  pointerMain: number;
  /** `pointerMain − dividerLeadingEdge` captured at pointerdown — the grab-offset that prevents a jump. */
  grabOffset: number;
  /** The split's enclosing rect (DividerRect.bounds). */
  bounds: Rect;
  dir: SplitDir;
  /** Divider thickness — MUST match solveRects (DEFAULT_DIVIDER_PX) or the divider drifts from the cursor. */
  dividerPx?: number;
  /** The min pane size the clamp enforces (MIN_PANE_PX). */
  min?: MinSize;
}

// Clamp to the numeric floor [MIN_RATIO, 1-MIN_RATIO] (the coarse setRatio floor).
function clampNumeric(r: number): number {
  return Math.min(Math.max(r, MIN_RATIO), 1 - MIN_RATIO);
}

/**
 * The new clamped ratio for a divider drag. Uses the solver's `available` denominator and the grab
 * offset (see the module header). Clamps so neither side falls below `min` px; when the split can't hold
 * two minimums (available < 2·minPx) or is degenerate (available ≤ 0), falls back to the numeric floor
 * so the math never divides by zero or extrapolates past the pane.
 */
export function ratioForDrag({
  pointerMain,
  grabOffset,
  bounds,
  dir,
  dividerPx = DEFAULT_DIVIDER_PX,
  min = MIN_PANE_PX,
}: DragInput): number {
  const mainStart = dir === "row" ? bounds.x : bounds.y;
  const mainLen = dir === "row" ? bounds.width : bounds.height;
  const available = mainLen - Math.min(dividerPx, mainLen);
  if (available <= 0) return RESET_RATIO; // degenerate rect — nothing to distribute
  const leadingEdge = pointerMain - grabOffset;
  const raw = (leadingEdge - mainStart) / available;
  const minPx = dir === "row" ? min.width : min.height;
  let lo = MIN_RATIO;
  let hi = 1 - MIN_RATIO;
  if (available >= 2 * minPx) {
    // The px minimum is the binding clamp when the pane is big enough to hold two minimums.
    lo = Math.max(lo, minPx / available);
    hi = Math.min(hi, 1 - minPx / available);
  }
  return Math.min(Math.max(raw, lo), hi);
}

/** The grab offset to record at pointerdown: how far the pointer is from the divider's leading edge. */
export function grabOffsetOf(pointerMain: number, dividerLeadingEdge: number): number {
  return pointerMain - dividerLeadingEdge;
}

export { clampNumeric as _clampNumericForTest };
