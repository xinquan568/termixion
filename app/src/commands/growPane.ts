// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94 (FR-3.3, the deferred keyboard divider resize): pick the divider to nudge when the focused
// pane grows in a direction, and the new ratio. Pure over the layout tree (unit-tested): find the
// NEAREST ancestor split whose axis matches the direction and whose divider sits on the grow side of
// the focused pane, then step its ratio by ±GROW_STEP, clamped to [MIN_RATIO, 1-MIN_RATIO]. Returns
// null at an edge (no divider that way) or when already clamped — a no-op.
import { MIN_RATIO, type LayoutNode, type SplitDir, type SplitPath } from "../panes/layoutTree";

/** The ratio step per keyboard grow (≈2% of the split's main axis). */
export const GROW_STEP = 0.02;

export type GrowDir = "left" | "right" | "up" | "down";

/** The split axis a direction acts on. */
const AXIS: Record<GrowDir, SplitDir> = { left: "row", right: "row", up: "column", down: "column" };
/** Which side of the split the focused pane must be on for its divider to face `dir`. */
const SIDE: Record<GrowDir, "first" | "second"> = {
  right: "first",
  left: "second",
  down: "first",
  up: "second",
};
/** The ratio delta sign: growing right/down enlarges the FIRST side (+); left/up the SECOND side (−). */
const SIGN: Record<GrowDir, 1 | -1> = { right: 1, left: -1, down: 1, up: -1 };

const clamp = (value: number) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, value));

/** The setPaneRatio target for growing `focusedPaneId` toward `dir`, or null (edge / already clamped). */
export function growTarget(
  tree: LayoutNode,
  focusedPaneId: number,
  dir: GrowDir,
): { path: SplitPath; ratio: number } | null {
  // Collect the ancestor splits on the path to the focused leaf, NEAREST-first (pushed on unwind).
  const ancestors: Array<{ split: Extract<LayoutNode, { kind: "split" }>; path: SplitPath; side: "first" | "second" }> = [];
  const walk = (node: LayoutNode, path: SplitPath): boolean => {
    if (node.kind === "leaf") return node.paneId === focusedPaneId;
    if (walk(node.first, [...path, "first"])) {
      ancestors.push({ split: node, path, side: "first" });
      return true;
    }
    if (walk(node.second, [...path, "second"])) {
      ancestors.push({ split: node, path, side: "second" });
      return true;
    }
    return false;
  };
  if (!walk(tree, [])) return null;

  const axis = AXIS[dir];
  const wantSide = SIDE[dir];
  const sign = SIGN[dir];
  for (const ancestor of ancestors) {
    if (ancestor.split.dir === axis && ancestor.side === wantSide) {
      const ratio = clamp(ancestor.split.ratio + sign * GROW_STEP);
      if (ratio === ancestor.split.ratio) return null; // already at the clamp — a no-op
      return { path: ancestor.path, ratio };
    }
  }
  return null; // no divider on that side — an edge, no-op
}
