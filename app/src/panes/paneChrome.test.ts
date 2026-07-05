// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-87 (test-first): the active-divider computation. Layouts use the real splitLeaf + solveRects so
// the divider rects/paths are exactly what App renders; the active set is the dividers OUTLINING the
// focused pane.
import { describe, it, expect } from "vitest";
import { activeDividerKeys, dividerKey } from "./paneChrome";
import { leafNode, solveRects, splitLeaf, type LayoutNode, type Rect } from "./layoutTree";

const BOUNDS: Rect = { x: 0, y: 0, width: 800, height: 600 };
const solve = (tree: LayoutNode) => solveRects(tree, BOUNDS, 1);
const active = (tree: LayoutNode, focused: number) => {
  const s = solve(tree);
  return activeDividerKeys(s.panes, s.dividers, focused);
};

// 2×2 grid ((1/3) | (2/4)): 1 top-left, 3 bottom-left, 2 top-right, 4 bottom-right.
function grid2x2(): LayoutNode {
  let tree = splitLeaf(leafNode(1), 1, "row", 2);
  tree = splitLeaf(tree, 1, "column", 3);
  tree = splitLeaf(tree, 2, "column", 4);
  return tree;
}

describe("dividerKey", () => {
  it("keys the root divider 'root' and nested by path", () => {
    expect(dividerKey([])).toBe("root");
    expect(dividerKey(["first"])).toBe("first");
    expect(dividerKey(["second", "first"])).toBe("second-first");
  });
});

describe("activeDividerKeys — single pane and 2x1", () => {
  it("a single pane has no dividers, so no active chrome", () => {
    expect(active(leafNode(1), 1).size).toBe(0);
  });

  it("2×1: the one divider bounds either pane (active for both)", () => {
    const t = splitLeaf(leafNode(1), 1, "row", 2);
    expect(active(t, 1)).toEqual(new Set(["root"]));
    expect(active(t, 2)).toEqual(new Set(["root"]));
  });

  it("an unknown focused pane yields an empty set", () => {
    expect(active(grid2x2(), 99).size).toBe(0);
  });
});

describe("activeDividerKeys — 2x2 grid outlines the focused pane", () => {
  const g = grid2x2();

  it("top-left (1) is outlined by the root (right edge) + left-column (bottom edge) dividers", () => {
    // root split = [] ('root'); left column split = ['first']; right column split = ['second'].
    expect(active(g, 1)).toEqual(new Set(["root", "first"]));
  });

  it("bottom-right (4) is outlined by the root + right-column dividers", () => {
    expect(active(g, 4)).toEqual(new Set(["root", "second"]));
  });

  it("moving focus changes the active set", () => {
    expect(active(g, 1)).not.toEqual(active(g, 4));
    expect(active(g, 3)).toEqual(new Set(["root", "first"])); // bottom-left: root + left column
    expect(active(g, 2)).toEqual(new Set(["root", "second"])); // top-right: root + right column
  });
});

describe("activeDividerKeys — T-shape", () => {
  it("the full-height left pane is outlined only by the root divider", () => {
    // ( 1 | (2/3) ): 1 spans the full height; its only bounding divider is the root vertical one.
    let t = splitLeaf(leafNode(1), 1, "row", 2);
    t = splitLeaf(t, 2, "column", 3);
    expect(active(t, 1)).toEqual(new Set(["root"]));
    // pane 2 (top-right) is outlined by the root (left edge) + the inner column (bottom edge).
    expect(active(t, 2)).toEqual(new Set(["root", "second"]));
  });
});
