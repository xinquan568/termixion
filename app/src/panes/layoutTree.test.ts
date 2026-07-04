// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-84: exhaustive unit tests for the pure pane layout tree — the milestone's RED start. Targets
// near-total branch coverage: split/remove/promotion/ratio-clamp, rect-tiling properties, min-size
// refusal, and a 16-leaf stress case.
import { describe, it, expect } from "vitest";
import {
  type LayoutNode,
  type Rect,
  type SolvedLayout,
  MIN_RATIO,
  canSplit,
  findLeaf,
  firstLeaf,
  leafNode,
  leaves,
  paneOrder,
  removeLeaf,
  setRatio,
  solveRects,
  splitLeaf,
} from "./layoutTree";

const BOUNDS: Rect = { x: 0, y: 0, width: 800, height: 600 };

// A row split of two leaves (1 | 2), 50/50.
function rowOf(a: number, b: number): LayoutNode {
  return splitLeaf(leafNode(a), a, "row", b);
}

describe("splitLeaf", () => {
  it("replaces the target leaf with a 50/50 split, existing pane FIRST and new pane SECOND", () => {
    const tree = splitLeaf(leafNode(1), 1, "row", 2);
    expect(tree).toEqual({
      kind: "split",
      dir: "row",
      ratio: 0.5,
      first: { kind: "leaf", paneId: 1 },
      second: { kind: "leaf", paneId: 2 },
    });
  });

  it("honors dir: row for Split Right, column for Split Below", () => {
    expect((splitLeaf(leafNode(1), 1, "row", 2) as { dir: string }).dir).toBe("row");
    expect((splitLeaf(leafNode(1), 1, "column", 2) as { dir: string }).dir).toBe("column");
  });

  it("is a === no-op for an unknown paneId", () => {
    const tree = rowOf(1, 2);
    expect(splitLeaf(tree, 99, "row", 3)).toBe(tree);
  });

  it("splits a nested leaf while leaving sibling subtrees by identity", () => {
    const tree = rowOf(1, 2); // (1 | 2)
    const next = splitLeaf(tree, 2, "column", 3) as { first: LayoutNode; second: LayoutNode };
    // pane 1's leaf is untouched (identity preserved)
    expect(next.first).toBe((tree as { first: LayoutNode }).first);
    // pane 2 became a column split (2 / 3)
    expect(next.second).toEqual({
      kind: "split",
      dir: "column",
      ratio: 0.5,
      first: { kind: "leaf", paneId: 2 },
      second: { kind: "leaf", paneId: 3 },
    });
    expect(leaves(next as LayoutNode)).toEqual([1, 2, 3]);
  });
});

describe("removeLeaf (sibling promotion)", () => {
  it("promotes the sibling and focuses its first leaf", () => {
    const tree = rowOf(1, 2);
    const r = removeLeaf(tree, 1);
    expect(r.tree).toEqual({ kind: "leaf", paneId: 2 });
    expect(r.focusNext).toBe(2);
  });

  it("removing SECOND promotes FIRST", () => {
    const tree = rowOf(1, 2);
    const r = removeLeaf(tree, 2);
    expect(r.tree).toEqual({ kind: "leaf", paneId: 1 });
    expect(r.focusNext).toBe(1);
  });

  it("removing the only leaf empties the tree", () => {
    expect(removeLeaf(leafNode(1), 1)).toEqual({ tree: null, focusNext: null });
  });

  it("is a no-op (=== tree) for an unknown paneId", () => {
    const tree = rowOf(1, 2);
    const r = removeLeaf(tree, 99);
    expect(r.tree).toBe(tree);
    expect(r.focusNext).toBeNull();
  });

  it("promotes a nested sibling SUBTREE (not just a leaf) and focuses its first leaf", () => {
    // ( 1 | (2 / 3) ) ; remove 1 -> the (2/3) subtree is promoted, focus its first leaf = 2
    let tree = rowOf(1, 2);
    tree = splitLeaf(tree, 2, "column", 3);
    const r = removeLeaf(tree, 1);
    expect(r.focusNext).toBe(2);
    expect(leaves(r.tree as LayoutNode)).toEqual([2, 3]);
    expect((r.tree as { kind: string }).kind).toBe("split");
  });

  it("removes a deeply nested leaf, promoting within the inner split", () => {
    // ( 1 | (2 / 3) ) ; remove 3 -> inner split collapses to leaf 2, focus 2
    let tree = rowOf(1, 2);
    tree = splitLeaf(tree, 2, "column", 3);
    const r = removeLeaf(tree, 3);
    expect(r.focusNext).toBe(2);
    expect(leaves(r.tree as LayoutNode)).toEqual([1, 2]);
  });
});

describe("setRatio", () => {
  it("sets the ratio of the split at a path", () => {
    const tree = rowOf(1, 2);
    const next = setRatio(tree, [], 0.7) as { ratio: number };
    expect(next.ratio).toBeCloseTo(0.7);
  });

  it("clamps into [MIN_RATIO, 1-MIN_RATIO]", () => {
    const tree = rowOf(1, 2);
    expect((setRatio(tree, [], 0) as { ratio: number }).ratio).toBeCloseTo(MIN_RATIO);
    expect((setRatio(tree, [], 1) as { ratio: number }).ratio).toBeCloseTo(1 - MIN_RATIO);
    expect((setRatio(tree, [], -5) as { ratio: number }).ratio).toBeCloseTo(MIN_RATIO);
  });

  it("targets a nested split by path", () => {
    let tree = rowOf(1, 2);
    tree = splitLeaf(tree, 2, "column", 3); // ( 1 | (2/3) )
    const next = setRatio(tree, ["second"], 0.25) as { second: { ratio: number } };
    expect(next.second.ratio).toBeCloseTo(0.25);
  });

  it("is a === no-op when the path points at a leaf or overshoots", () => {
    const tree = rowOf(1, 2);
    expect(setRatio(tree, ["first"], 0.3)).toBe(tree); // first is a leaf
    expect(setRatio(tree, ["first", "second"], 0.3)).toBe(tree); // too long
  });
});

// ---- rect solver properties ----

/** Sum of all rect areas (panes + dividers). */
function totalArea(solved: SolvedLayout): number {
  const all = [...solved.panes.map((p) => p.rect), ...solved.dividers.map((d) => d.rect)];
  return all.reduce((acc, r) => acc + r.width * r.height, 0);
}

/** True if two rects overlap with positive area. */
function overlaps(a: Rect, b: Rect): boolean {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return ix > 0 && iy > 0;
}

function assertTiles(solved: SolvedLayout, bounds: Rect): void {
  // 1. areas sum exactly to the bounds (no gaps, no overlaps by area)
  expect(totalArea(solved)).toBe(bounds.width * bounds.height);
  // 2. pairwise non-overlap across every rect
  const all = [...solved.panes.map((p) => p.rect), ...solved.dividers.map((d) => d.rect)];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      expect(overlaps(all[i], all[j])).toBe(false);
    }
  }
  // 3. everything stays within bounds
  for (const r of all) {
    expect(r.x).toBeGreaterThanOrEqual(bounds.x);
    expect(r.y).toBeGreaterThanOrEqual(bounds.y);
    expect(r.x + r.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(r.y + r.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  }
}

describe("solveRects", () => {
  it("a single leaf fills the whole bounds with no dividers", () => {
    const solved = solveRects(leafNode(1), BOUNDS);
    expect(solved.panes).toEqual([{ paneId: 1, rect: BOUNDS }]);
    expect(solved.dividers).toEqual([]);
  });

  it("row split: first left, second right, vertical divider between", () => {
    const solved = solveRects(rowOf(1, 2), BOUNDS, 2);
    const p1 = solved.panes.find((p) => p.paneId === 1)!.rect;
    const p2 = solved.panes.find((p) => p.paneId === 2)!.rect;
    expect(p1.x).toBe(0);
    expect(p1.width).toBe(399); // round((800-2)*0.5)
    expect(p2.x).toBe(401); // 399 + 2 divider
    expect(p2.width).toBe(399);
    expect(solved.dividers[0].rect).toEqual({ x: 399, y: 0, width: 2, height: 600 });
    expect(solved.dividers[0].dir).toBe("row");
    assertTiles(solved, BOUNDS);
  });

  it("column split: first top, second bottom, horizontal divider", () => {
    const tree = splitLeaf(leafNode(1), 1, "column", 2);
    const solved = solveRects(tree, BOUNDS, 2);
    const p1 = solved.panes.find((p) => p.paneId === 1)!.rect;
    const p2 = solved.panes.find((p) => p.paneId === 2)!.rect;
    expect(p1.y).toBe(0);
    expect(p1.height).toBe(299); // round((600-2)*0.5)
    expect(p2.y).toBe(301);
    expect(p2.height).toBe(299);
    expect(solved.dividers[0].rect).toEqual({ x: 0, y: 299, width: 800, height: 2 });
    assertTiles(solved, BOUNDS);
  });

  it("tiles the bounds exactly for a nested mixed tree (every leaf present once)", () => {
    // ( 1 | ( 2 / 3 ) )
    let tree = rowOf(1, 2);
    tree = splitLeaf(tree, 2, "column", 3);
    const solved = solveRects(tree, BOUNDS, 1);
    expect(solved.panes.map((p) => p.paneId).sort()).toEqual([1, 2, 3]);
    assertTiles(solved, BOUNDS);
  });

  it("is deterministic (same input -> equal output)", () => {
    let tree = rowOf(1, 2);
    tree = splitLeaf(tree, 2, "column", 3);
    expect(solveRects(tree, BOUNDS)).toEqual(solveRects(tree, BOUNDS));
  });

  it("respects a non-default ratio", () => {
    const tree = setRatio(rowOf(1, 2), [], 0.25);
    const solved = solveRects(tree, BOUNDS, 0);
    expect(solved.panes.find((p) => p.paneId === 1)!.rect.width).toBe(200); // 800*0.25
    expect(solved.panes.find((p) => p.paneId === 2)!.rect.width).toBe(600);
  });

  it("tiles a rect NARROWER than the divider without overflowing (divider capped to the axis)", () => {
    const narrow: Rect = { x: 10, y: 0, width: 3, height: 100 };
    const solved = solveRects(rowOf(1, 2), narrow, 5); // divider (5) > width (3)
    assertTiles(solved, narrow); // exact tiling, and NOTHING escapes the bounds
    expect(solved.dividers[0].rect.width).toBeLessThanOrEqual(narrow.width);
  });

  it("tiles a rect SHORTER than the divider (column) without overflowing", () => {
    const short: Rect = { x: 0, y: 5, width: 100, height: 2 };
    const tree = splitLeaf(leafNode(1), 1, "column", 2);
    const solved = solveRects(tree, short, 5);
    assertTiles(solved, short);
    expect(solved.dividers[0].rect.height).toBeLessThanOrEqual(short.height);
  });

  it("tiles a zero-size bound (degenerate) without overflow", () => {
    const zero: Rect = { x: 0, y: 0, width: 0, height: 0 };
    assertTiles(solveRects(rowOf(1, 2), zero, 1), zero);
  });
});

describe("leaves / paneOrder / findLeaf", () => {
  it("leaves lists paneIds in DFS (first-before-second) order", () => {
    let tree = rowOf(1, 2);
    tree = splitLeaf(tree, 2, "column", 3); // ( 1 | (2/3) )
    expect(leaves(tree)).toEqual([1, 2, 3]);
    expect(paneOrder(tree)).toEqual([1, 2, 3]);
  });

  it("findLeaf returns the path or null", () => {
    let tree = rowOf(1, 2);
    tree = splitLeaf(tree, 2, "column", 3);
    expect(findLeaf(tree, 1)).toEqual(["first"]);
    expect(findLeaf(tree, 3)).toEqual(["second", "second"]);
    expect(findLeaf(tree, 99)).toBeNull();
  });

  it("firstLeaf walks the first side", () => {
    let tree = rowOf(1, 2);
    tree = splitLeaf(tree, 1, "column", 3); // ( (1/3) | 2 )
    expect(firstLeaf(tree)).toBe(1);
  });
});

describe("canSplit (min-size guard)", () => {
  const MIN = { width: 80, height: 60 };

  it("allows a split that leaves both halves above the minimum", () => {
    expect(canSplit(leafNode(1), 1, "row", BOUNDS, MIN)).toBe(true);
    expect(canSplit(leafNode(1), 1, "column", BOUNDS, MIN)).toBe(true);
  });

  it("refuses a row split when the pane is too narrow to halve", () => {
    const narrow: Rect = { x: 0, y: 0, width: 150, height: 600 };
    expect(canSplit(leafNode(1), 1, "row", narrow, MIN)).toBe(false); // 150 -> ~74 each < 80
  });

  it("refuses a column split when the pane is too short to halve", () => {
    const short: Rect = { x: 0, y: 0, width: 800, height: 110 };
    expect(canSplit(leafNode(1), 1, "column", short, MIN)).toBe(false);
  });

  it("refuses splitting an unknown pane", () => {
    expect(canSplit(leafNode(1), 99, "row", BOUNDS, MIN)).toBe(false);
  });

  it("evaluates the ACTUAL sub-rect of a nested pane, not the whole bounds", () => {
    // 1 already shares the width with 2; splitting 1 again along row halves a ~400px pane -> ok,
    // but a very small bounds makes the nested pane too small.
    const tree = rowOf(1, 2);
    const tiny: Rect = { x: 0, y: 0, width: 300, height: 600 };
    // pane 1 is ~150 wide here; a further row split -> ~74 each < 80 -> refused
    expect(canSplit(tree, 1, "row", tiny, MIN)).toBe(false);
  });
});

describe("16-leaf stress", () => {
  it("builds 16 panes and solves a correct, tiling layout", () => {
    let tree: LayoutNode = leafNode(1);
    let next = 2;
    // repeatedly split the last-created pane, alternating direction
    for (let i = 0; i < 15; i++) {
      const target = next - 1;
      const dir = i % 2 === 0 ? "row" : "column";
      tree = splitLeaf(tree, target, dir, next);
      next++;
    }
    const ids = leaves(tree);
    expect(ids).toHaveLength(16);
    expect(new Set(ids).size).toBe(16); // all distinct
    const solved = solveRects(tree, BOUNDS, 1);
    expect(solved.panes).toHaveLength(16);
    assertTiles(solved, BOUNDS);
  });
});
