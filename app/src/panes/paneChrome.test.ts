// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-87 (test-first): the active-divider computation. Layouts use the real splitLeaf + solveRects so
// the divider rects/paths are exactly what App renders; the active set is the dividers OUTLINING the
// focused pane.
import { describe, it, expect } from "vitest";
import { activeDividerKeys, activeDividerSegments, dividerKey } from "./paneChrome";
import { leafNode, solveRects, splitLeaf, type LayoutNode, type Rect } from "./layoutTree";

const BOUNDS: Rect = { x: 0, y: 0, width: 800, height: 600 };
const solve = (tree: LayoutNode) => solveRects(tree, BOUNDS, 1);
const active = (tree: LayoutNode, focused: number) => {
  const s = solve(tree);
  return activeDividerKeys(s.panes, s.dividers, focused);
};
const segs = (tree: LayoutNode, focused: number) => {
  const s = solve(tree);
  return activeDividerSegments(s.panes, s.dividers, focused);
};
const dividerRect = (tree: LayoutNode, key: string) => {
  const d = solve(tree).dividers.find((r) => dividerKey(r.path) === key);
  if (!d) throw new Error(`no divider '${key}'`);
  return d.rect;
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

// trmx-175: the active border is SEGMENTED — a divider is colored active only over the sub-span where it
// actually borders the focused pane (its perpendicular overlap), not along its whole length. The bug: a
// full-height root divider whose lower half borders the focused (bottom) pane was colored active along its
// ENTIRE height, so its upper half — between two UNFOCUSED panes — was wrongly blue.
describe("activeDividerSegments — colors only the span adjacent to the focused pane (trmx-175)", () => {
  it("2×1: the single divider's active segment spans its full cross-axis (no regression)", () => {
    const t = splitLeaf(leafNode(1), 1, "row", 2);
    const root = dividerRect(t, "root");
    for (const focused of [1, 2]) {
      const seg = segs(t, focused).get("root");
      expect(seg).toBeDefined();
      expect(seg!.offset).toBe(0);
      expect(seg!.length).toBe(root.height); // fully-adjacent → covers the whole line → looks fully active
    }
  });

  it("2×2 focus bottom-left (3): the full-height root divider is colored ONLY over the bottom pane", () => {
    const g = grid2x2();
    const root = dividerRect(g, "root");
    const seg = segs(g, 3).get("root");
    expect(seg).toBeDefined();
    expect(seg!.offset).toBeGreaterThan(0); // NOT top-aligned (the bug colored the whole line from y=0)
    expect(seg!.length).toBeLessThan(root.height); // strictly partial — the top half stays inactive
    expect(seg!.offset + seg!.length).toBe(root.height); // bottom-aligned: reaches the divider's end, no gap
    // the left-column divider it also bounds is fully covered (it borders pane 3's whole top edge)
    const first = dividerRect(g, "first");
    const fseg = segs(g, 3).get("first");
    expect(fseg!.offset).toBe(0);
    expect(fseg!.length).toBe(first.width);
  });

  it("2×2 focus top-left (1): the root divider is colored only over the TOP pane (top-aligned, partial)", () => {
    const g = grid2x2();
    const root = dividerRect(g, "root");
    const seg = segs(g, 1).get("root");
    expect(seg!.offset).toBe(0); // top-aligned
    expect(seg!.length).toBeLessThan(root.height); // only the top pane's height, not the whole line
  });

  it("segment keys equal activeDividerKeys (a divider is 'active' iff it has a segment)", () => {
    const g = grid2x2();
    expect(new Set(segs(g, 3).keys())).toEqual(active(g, 3));
    expect(new Set(segs(g, 4).keys())).toEqual(active(g, 4));
  });

  it("a horizontal (column-split) root divider segments along X (orientation-symmetric)", () => {
    let t = splitLeaf(leafNode(1), 1, "column", 2); // 1 over 2 → a full-width horizontal root divider
    t = splitLeaf(t, 2, "row", 3); // bottom row → 2 | 3
    const root = dividerRect(t, "root");
    const seg = segs(t, 3).get("root"); // focus bottom-right
    expect(seg!.offset).toBeGreaterThan(0); // colored only over the right part
    expect(seg!.length).toBeLessThan(root.width);
    expect(seg!.offset + seg!.length).toBe(root.width); // right-aligned to the divider's end
  });

  it("an unknown focused pane yields no segments", () => {
    expect(segs(grid2x2(), 99).size).toBe(0);
  });
});
