// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-100 (FR-3.4, test-first): the re-dock tree ops — moveLeaf / swapLeaves / canDropEdge (layoutTree)
// + movePaneDirectional (paneNav). Trees are built with the real splitLeaf/solveRects so rects match
// runtime; invariants: leaf-SET preserved, valid ratios, rects still tile, === on every no-op.
import { describe, it, expect } from "vitest";
import {
  moveLeaf,
  swapLeaves,
  canDropEdge,
  sameTree,
  leafNode,
  leaves,
  solveRects,
  splitLeaf,
  MIN_PANE_PX,
  type LayoutNode,
  type Rect,
  type SolvedLayout,
} from "./layoutTree";
import { movePaneDirectional } from "./paneNav";

const BOUNDS: Rect = { x: 0, y: 0, width: 800, height: 600 };
const sortNums = (xs: number[]) => [...xs].sort((a, b) => a - b);

// A row split (1 | 2).
const rowOf = (a: number, b: number): LayoutNode => splitLeaf(leafNode(a), a, "row", b);
// A 2×2 grid ((1/3)|(2/4)): leaves order 1,3,2,4.
function grid2x2(): LayoutNode {
  let t = splitLeaf(leafNode(1), 1, "row", 2);
  t = splitLeaf(t, 1, "column", 3);
  t = splitLeaf(t, 2, "column", 4);
  return t;
}

function assertTiles(solved: SolvedLayout, bounds: Rect): void {
  const all = [...solved.panes.map((p) => p.rect), ...solved.dividers.map((d) => d.rect)];
  const area = all.reduce((a, r) => a + r.width * r.height, 0);
  expect(area).toBe(bounds.width * bounds.height);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      expect(ix > 0 && iy > 0).toBe(false);
    }
  }
}
function assertValidRatios(node: LayoutNode): void {
  if (node.kind === "split") {
    expect(node.ratio).toBeGreaterThan(0);
    expect(node.ratio).toBeLessThan(1);
    assertValidRatios(node.first);
    assertValidRatios(node.second);
  }
}

describe("moveLeaf", () => {
  it("docks the moved pane on each edge of the target (2×2 grid) — leaf-set preserved, tiles", () => {
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      const t = moveLeaf(grid2x2(), 1, 4, edge);
      expect(sortNums(leaves(t))).toEqual([1, 2, 3, 4]); // same panes, moved present once
      assertValidRatios(t);
      assertTiles(solveRects(t, BOUNDS, 1), BOUNDS);
    }
  });

  it("right-docks onto the target: [A|B] moveLeaf(A→B right) becomes [B|A]", () => {
    const t = moveLeaf(rowOf(1, 2), 1, 2, "right");
    // now 2 is first (left), 1 is second (right)
    expect(t).toMatchObject({ kind: "split", dir: "row" });
    if (t.kind === "split") {
      expect(t.first).toMatchObject({ paneId: 2 });
      expect(t.second).toMatchObject({ paneId: 1 });
    }
  });

  it("returns the SAME tree (===) for self, unknown, and the adjacent facing-edge structural no-op", () => {
    const t = rowOf(1, 2);
    expect(moveLeaf(t, 1, 1, "left")).toBe(t); // self
    expect(moveLeaf(t, 9, 2, "left")).toBe(t); // unknown source
    expect(moveLeaf(t, 1, 9, "left")).toBe(t); // unknown target
    // [1|2], move 1 onto 2's LEFT edge → [1|2] again (structurally identical) → the === original
    expect(moveLeaf(t, 1, 2, "left")).toBe(t);
  });

  it("preserves the moved pane's paneId identity (session survival guarantee)", () => {
    const t = moveLeaf(grid2x2(), 1, 4, "bottom");
    expect(leaves(t)).toContain(1); // same id, not a fresh one
    expect(sortNums(leaves(t))).toEqual([1, 2, 3, 4]);
  });
});

describe("swapLeaves", () => {
  it("swaps two panes' slots, preserving structure and ratios", () => {
    const t = swapLeaves(grid2x2(), 1, 4);
    expect(sortNums(leaves(t))).toEqual([1, 2, 3, 4]);
    // structurally identical to a grid with 1<->4 traded
    const expected = swapLeaves(grid2x2(), 1, 4);
    expect(sameTree(t, expected)).toBe(true);
    assertTiles(solveRects(t, BOUNDS, 1), BOUNDS);
  });
  it("returns the SAME tree (===) for a===b or an unknown pane", () => {
    const t = grid2x2();
    expect(swapLeaves(t, 2, 2)).toBe(t);
    expect(swapLeaves(t, 2, 99)).toBe(t);
  });
});

describe("canDropEdge", () => {
  it("allows an edge drop when both halves stay above the floor, refuses when too small", () => {
    const t = rowOf(1, 2); // each pane ~400px wide, 600 tall — roomy
    expect(canDropEdge(t, 2, "left", BOUNDS)).toBe(true);
    // a tiny bounds makes a horizontal split under-size (< MIN_PANE_PX.width * 2)
    const tiny: Rect = { x: 0, y: 0, width: MIN_PANE_PX.width, height: 600 };
    expect(canDropEdge(leafNode(1), 1, "left", tiny)).toBe(false);
  });
});

describe("movePaneDirectional (keyboard)", () => {
  it("flips a two-pane row: [1|2] move-right on 1 → [2|1]", () => {
    const t = movePaneDirectional(rowOf(1, 2), 1, "right", BOUNDS);
    if (t.kind === "split") {
      expect(t.first).toMatchObject({ paneId: 2 });
      expect(t.second).toMatchObject({ paneId: 1 });
    } else {
      throw new Error("expected a split");
    }
  });
  it("is a === no-op when there is no neighbor in the direction (edge pane)", () => {
    const t = rowOf(1, 2);
    expect(movePaneDirectional(t, 1, "left", BOUNDS)).toBe(t); // 1 is leftmost
    expect(movePaneDirectional(t, 2, "right", BOUNDS)).toBe(t); // 2 is rightmost
    expect(movePaneDirectional(t, 1, "up", BOUNDS)).toBe(t); // no vertical neighbor
  });
  it("moves within a 2×2 grid, preserving the leaf set and tiling", () => {
    const t = movePaneDirectional(grid2x2(), 1, "right", BOUNDS); // neighbor is 2
    expect(sortNums(leaves(t))).toEqual([1, 2, 3, 4]);
    assertTiles(solveRects(t, BOUNDS, 1), BOUNDS);
  });
});
