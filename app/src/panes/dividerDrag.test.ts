// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-85 (test-first): the pure divider-drag math. The load-bearing tests run the FULL round trip —
// pointer → ratioForDrag → setRatio → solveRects → divider leading edge — so a wrong denominator or a
// missing grab-offset shows up as the divider drifting from the cursor, not just an out-of-range ratio.
import { describe, it, expect } from "vitest";
import { ratioForDrag, grabOffsetOf, RESET_RATIO } from "./dividerDrag";
import {
  DEFAULT_DIVIDER_PX,
  MIN_PANE_PX,
  leafNode,
  setRatio,
  solveRects,
  splitLeaf,
  type Rect,
  type SplitDir,
} from "./layoutTree";

function rowOf(a: number, b: number) {
  return splitLeaf(leafNode(a), a, "row", b);
}
function colOf(a: number, b: number) {
  return splitLeaf(leafNode(a), a, "column", b);
}

// Apply a dragged ratio through the real solver and return the divider's leading edge + child sizes,
// so a test asserts the divider lands where the pointer asked (the honest end-to-end check).
function applyDrag(
  tree: ReturnType<typeof rowOf>,
  bounds: Rect,
  dir: SplitDir,
  ratio: number,
  dividerPx: number,
) {
  const solved = solveRects(setRatio(tree, [], ratio), bounds, dividerPx);
  const div = solved.dividers[0];
  const leadingEdge = dir === "row" ? div.rect.x : div.rect.y;
  const panes = solved.panes;
  const firstMain =
    dir === "row" ? panes.find((p) => p.paneId === 1)!.rect.width : panes.find((p) => p.paneId === 1)!.rect.height;
  const secondMain =
    dir === "row" ? panes.find((p) => p.paneId === 2)!.rect.width : panes.find((p) => p.paneId === 2)!.rect.height;
  return { leadingEdge, firstMain, secondMain };
}

describe("ratioForDrag — full solver round trip", () => {
  it("row: the divider lands at the pointer (non-zero origin, non-default divider)", () => {
    const bounds: Rect = { x: 100, y: 50, width: 600, height: 400 };
    const target = 300; // desired divider leading edge (interior)
    const ratio = ratioForDrag({ pointerMain: target, grabOffset: 0, bounds, dir: "row", dividerPx: 4 });
    const { leadingEdge, firstMain, secondMain } = applyDrag(rowOf(1, 2), bounds, "row", ratio, 4);
    expect(Math.abs(leadingEdge - target)).toBeLessThanOrEqual(1); // tracks the cursor (± rounding)
    expect(firstMain).toBeGreaterThanOrEqual(MIN_PANE_PX.width);
    expect(secondMain).toBeGreaterThanOrEqual(MIN_PANE_PX.width);
  });

  it("column: the divider lands at the pointer along the y axis", () => {
    const bounds: Rect = { x: 0, y: 20, width: 500, height: 600 };
    const target = 260;
    const ratio = ratioForDrag({ pointerMain: target, grabOffset: 0, bounds, dir: "column", dividerPx: 3 });
    const { leadingEdge, firstMain, secondMain } = applyDrag(colOf(1, 2), bounds, "column", ratio, 3);
    expect(Math.abs(leadingEdge - target)).toBeLessThanOrEqual(1);
    expect(firstMain).toBeGreaterThanOrEqual(MIN_PANE_PX.height);
    expect(secondMain).toBeGreaterThanOrEqual(MIN_PANE_PX.height);
  });

  it("clamps at the min pane size on an extreme drag — child == min, no off-by-one (row)", () => {
    const bounds: Rect = { x: 0, y: 0, width: 600, height: 400 };
    const ratio = ratioForDrag({ pointerMain: -9999, grabOffset: 0, bounds, dir: "row", dividerPx: 4 });
    const { firstMain, secondMain } = applyDrag(rowOf(1, 2), bounds, "row", ratio, 4);
    expect(firstMain).toBe(MIN_PANE_PX.width); // exactly the minimum, not below
    expect(secondMain).toBeGreaterThanOrEqual(MIN_PANE_PX.width);
  });

  it("clamps at the min on the other extreme too (row)", () => {
    const bounds: Rect = { x: 0, y: 0, width: 600, height: 400 };
    const ratio = ratioForDrag({ pointerMain: 9999, grabOffset: 0, bounds, dir: "row", dividerPx: 4 });
    const { firstMain, secondMain } = applyDrag(rowOf(1, 2), bounds, "row", ratio, 4);
    expect(secondMain).toBe(MIN_PANE_PX.width);
    expect(firstMain).toBeGreaterThanOrEqual(MIN_PANE_PX.width);
  });
});

describe("ratioForDrag — grab offset (no jump on drag start)", () => {
  it("does NOT snap the divider to the pointer when the grab was beside the 1px line", () => {
    const bounds: Rect = { x: 0, y: 0, width: 600, height: 400 };
    // Divider currently at leading edge 200; the user grabbed at x=203 (3px into the hit area).
    const grabOffset = grabOffsetOf(203, 200);
    expect(grabOffset).toBe(3);
    // A "move" with the pointer STILL at 203 must keep the divider at 200 (no jump to 203).
    const ratioNoMove = ratioForDrag({ pointerMain: 203, grabOffset, bounds, dir: "row", dividerPx: 4 });
    expect(applyDrag(rowOf(1, 2), bounds, "row", ratioNoMove, 4).leadingEdge).toBe(200);
    // Now drag 50px right → the divider moves by ~50 (to 250), i.e. by the DELTA, not to the raw pointer.
    const ratioMoved = ratioForDrag({ pointerMain: 253, grabOffset, bounds, dir: "row", dividerPx: 4 });
    expect(Math.abs(applyDrag(rowOf(1, 2), bounds, "row", ratioMoved, 4).leadingEdge - 250)).toBeLessThanOrEqual(1);
  });
});

describe("ratioForDrag — degenerate & tiny bounds", () => {
  it("returns the reset ratio for a degenerate (available ≤ 0) rect, never NaN", () => {
    const bounds: Rect = { x: 0, y: 0, width: 4, height: 100 };
    const r = ratioForDrag({ pointerMain: 2, grabOffset: 0, bounds, dir: "row", dividerPx: 4 });
    expect(r).toBe(RESET_RATIO);
    expect(Number.isNaN(r)).toBe(false);
  });

  it("falls back to the numeric floor when the pane can't hold two minimums (available < 2·minPx)", () => {
    const bounds: Rect = { x: 0, y: 0, width: 150, height: 400 }; // available 146 < 160
    const r = ratioForDrag({ pointerMain: 9999, grabOffset: 0, bounds, dir: "row", dividerPx: 4 });
    expect(r).toBeGreaterThanOrEqual(0.05);
    expect(r).toBeLessThanOrEqual(0.95);
    expect(Number.isNaN(r)).toBe(false);
  });

  it("uses the default divider px when omitted (matches the solver default)", () => {
    const bounds: Rect = { x: 0, y: 0, width: 800, height: 600 };
    const withDefault = ratioForDrag({ pointerMain: 400, grabOffset: 0, bounds, dir: "row" });
    const explicit = ratioForDrag({ pointerMain: 400, grabOffset: 0, bounds, dir: "row", dividerPx: DEFAULT_DIVIDER_PX });
    expect(withDefault).toBe(explicit);
  });

  it("clamps at the min pane HEIGHT on an extreme column drag (round trip)", () => {
    const bounds: Rect = { x: 0, y: 0, width: 400, height: 500 };
    const ratio = ratioForDrag({ pointerMain: -9999, grabOffset: 0, bounds, dir: "column", dividerPx: 3 });
    const { firstMain, secondMain } = applyDrag(colOf(1, 2), bounds, "column", ratio, 3);
    expect(firstMain).toBe(MIN_PANE_PX.height); // exactly the minimum height, not below
    expect(secondMain).toBeGreaterThanOrEqual(MIN_PANE_PX.height);
  });

  it("a capped-gap rect (mainLen < dividerPx) resets rather than dividing by zero", () => {
    const bounds: Rect = { x: 0, y: 0, width: 2, height: 100 }; // width 2 < dividerPx 4 → available 0
    const r = ratioForDrag({ pointerMain: 1, grabOffset: 0, bounds, dir: "row", dividerPx: 4 });
    expect(r).toBe(RESET_RATIO);
    expect(Number.isNaN(r)).toBe(false);
  });
});
