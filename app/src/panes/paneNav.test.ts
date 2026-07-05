// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-86 (test-first): pure pane navigation. Layouts are built with the real splitLeaf + solveRects so
// the rects (and their divider gaps) are exactly what App feeds paneInDirection at runtime.
import { describe, it, expect } from "vitest";
import { paneInDirection, nextPane, type Direction } from "./paneNav";
import { leafNode, leaves, solveRects, splitLeaf, type LayoutNode, type Rect } from "./layoutTree";

const BOUNDS: Rect = { x: 0, y: 0, width: 800, height: 600 };
const panesOf = (tree: LayoutNode) => solveRects(tree, BOUNDS, 1).panes;
const dir = (tree: LayoutNode, from: number, d: Direction) => paneInDirection(panesOf(tree), from, d);

// A 2×2 grid: ((1/3) | (2/4)) — 1 top-left, 3 bottom-left, 2 top-right, 4 bottom-right; leaves order 1,3,2,4.
function grid2x2(): LayoutNode {
  let tree = splitLeaf(leafNode(1), 1, "row", 2);
  tree = splitLeaf(tree, 1, "column", 3);
  tree = splitLeaf(tree, 2, "column", 4);
  return tree;
}

describe("paneInDirection — 2x2 grid", () => {
  const g = grid2x2();

  it("moves right/down from the top-left pane", () => {
    expect(dir(g, 1, "right")).toBe(2); // top-right
    expect(dir(g, 1, "down")).toBe(3); // bottom-left
    expect(dir(g, 1, "left")).toBeNull(); // edge — no wrap
    expect(dir(g, 1, "up")).toBeNull();
  });

  it("moves left/up from the bottom-right pane", () => {
    expect(dir(g, 4, "left")).toBe(3); // bottom-left
    expect(dir(g, 4, "up")).toBe(2); // top-right
    expect(dir(g, 4, "right")).toBeNull();
    expect(dir(g, 4, "down")).toBeNull();
  });

  it("moves from the other two corners", () => {
    expect(dir(g, 2, "left")).toBe(1); // top-right → top-left
    expect(dir(g, 2, "down")).toBe(4);
    expect(dir(g, 3, "right")).toBe(4); // bottom-left → bottom-right
    expect(dir(g, 3, "up")).toBe(1);
  });

  it("an unknown from-pane is null", () => {
    expect(dir(g, 99, "right")).toBeNull();
  });
});

describe("paneInDirection — 2x1 and single pane", () => {
  it("2x1 (1 | 2): horizontal moves, vertical no-ops", () => {
    const t = splitLeaf(leafNode(1), 1, "row", 2);
    expect(dir(t, 1, "right")).toBe(2);
    expect(dir(t, 2, "left")).toBe(1);
    expect(dir(t, 1, "up")).toBeNull();
    expect(dir(t, 1, "down")).toBeNull();
    expect(dir(t, 2, "right")).toBeNull();
  });

  it("a single pane is a no-op in all four directions", () => {
    const t = leafNode(1);
    for (const d of ["left", "right", "up", "down"] as Direction[]) expect(dir(t, 1, d)).toBeNull();
  });
});

describe("paneInDirection — overlap tiebreak (T-shape)", () => {
  it("prefers the larger perpendicular overlap when distances tie", () => {
    // ( 1 | (2/3) ): 1 is the full-height left column; 2 top-right, 3 bottom-right.
    let t = splitLeaf(leafNode(1), 1, "row", 2);
    t = splitLeaf(t, 2, "column", 3);
    // Both 2 and 3 are one divider to the right of 1 (equal distance); 2's overlap with 1 (top half) is
    // ≥ 3's (bottom half), and the topmost tiebreak also favors 2.
    expect(dir(t, 1, "right")).toBe(2);
    // From the top-right pane, left returns the full-height left pane.
    expect(dir(t, 2, "left")).toBe(1);
    expect(dir(t, 3, "left")).toBe(1);
  });
});

describe("nextPane — cyclic over leaves order", () => {
  const g = grid2x2();

  it("cycles forward over the stable DFS order, wrapping", () => {
    expect(leaves(g)).toEqual([1, 3, 2, 4]);
    expect(nextPane(g, 1, 1)).toBe(3);
    expect(nextPane(g, 3, 1)).toBe(2);
    expect(nextPane(g, 2, 1)).toBe(4);
    expect(nextPane(g, 4, 1)).toBe(1); // wrap
  });

  it("cycles backward, wrapping", () => {
    expect(nextPane(g, 1, -1)).toBe(4); // wrap
    expect(nextPane(g, 4, -1)).toBe(2);
  });

  it("a single pane returns itself; an unknown pane is null", () => {
    expect(nextPane(leafNode(1), 1, 1)).toBe(1);
    expect(nextPane(g, 99, 1)).toBeNull();
  });
});
