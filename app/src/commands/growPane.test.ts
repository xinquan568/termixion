// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import { describe, expect, it } from "vitest";
import { GROW_STEP, growTarget } from "./growPane";
import { MIN_RATIO, type LayoutNode } from "../panes/layoutTree";

const leaf = (paneId: number): LayoutNode => ({ kind: "leaf", paneId });
// A row split (side-by-side): pane 1 left, pane 2 right, ratio 0.5.
const rowTree: LayoutNode = { kind: "split", dir: "row", ratio: 0.5, first: leaf(1), second: leaf(2) };
// A column split (stacked): pane 1 top, pane 2 bottom.
const colTree: LayoutNode = { kind: "split", dir: "column", ratio: 0.5, first: leaf(1), second: leaf(2) };

describe("growTarget", () => {
  it("grow-right from the LEFT pane increases the row divider ratio", () => {
    expect(growTarget(rowTree, 1, "right")).toEqual({ path: [], ratio: 0.5 + GROW_STEP });
  });
  it("grow-left from the RIGHT pane decreases the row divider ratio", () => {
    expect(growTarget(rowTree, 2, "left")).toEqual({ path: [], ratio: 0.5 - GROW_STEP });
  });
  it("grow-down from the TOP pane increases the column divider ratio", () => {
    expect(growTarget(colTree, 1, "down")).toEqual({ path: [], ratio: 0.5 + GROW_STEP });
  });
  it("grow-up from the BOTTOM pane decreases the column divider ratio", () => {
    expect(growTarget(colTree, 2, "up")).toEqual({ path: [], ratio: 0.5 - GROW_STEP });
  });

  it("returns null at an edge (no divider that way)", () => {
    // The left pane can't grow LEFT (its left edge is the window), nor UP (a row split has no column divider).
    expect(growTarget(rowTree, 1, "left")).toBeNull();
    expect(growTarget(rowTree, 1, "up")).toBeNull();
  });

  it("returns null when the divider is already at the clamp", () => {
    const pinned: LayoutNode = { kind: "split", dir: "row", ratio: 1 - MIN_RATIO, first: leaf(1), second: leaf(2) };
    expect(growTarget(pinned, 1, "right")).toBeNull(); // can't push it further right
  });

  it("picks the NEAREST matching divider in a nested tree", () => {
    // outer column split; its `first` is a row split of panes 1|2, its `second` is pane 3.
    const nested: LayoutNode = {
      kind: "split",
      dir: "column",
      ratio: 0.5,
      first: { kind: "split", dir: "row", ratio: 0.4, first: leaf(1), second: leaf(2) },
      second: leaf(3),
    };
    // grow-right from pane 1 → the inner row split at path ["first"], ratio 0.4 + step.
    expect(growTarget(nested, 1, "right")).toEqual({ path: ["first"], ratio: 0.4 + GROW_STEP });
    // grow-down from pane 1 → the outer column split at path [], ratio 0.5 + step.
    expect(growTarget(nested, 1, "down")).toEqual({ path: [], ratio: 0.5 + GROW_STEP });
  });
});
