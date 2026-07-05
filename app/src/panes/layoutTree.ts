// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-84 (FR-3.1/FR-3.2): the pure pane layout tree — the heart of split panes. A tab owns a binary
// split tree; this module is the pure, React-free algebra over it (as tabState.ts is for tabs), so
// every split/close/resize transition AND the rect geometry are unit-testable headless. The render
// layer (App.tsx) turns solveRects output into absolutely-positioned, paneId-keyed SIBLING divs —
// never nested DOM — so a re-layout mutates only geometry and never remounts a terminal (the
// roadmap's "move, don't recreate" constraint).
//
// Conventions:
// - dir "row"    = first | second side by side (a VERTICAL divider)   = Split Right (⌘D).
// - dir "column" = first stacked above second (a HORIZONTAL divider)  = Split Below (⇧⌘D).
// - `ratio` is the fraction of the split's main axis given to `first` (0..1).
// - Pure: every op returns a NEW node; a no-op (unknown paneId / path) returns the SAME node (===),
//   mirroring tabState.ts so a React consumer can skip re-renders and tests can pin no-op-ness.

/** A pane's stable identity within the app. Monotonic + never reused (allocated in tabState). */
export type PaneId = number;

/** A split's main axis: "row" = side-by-side (Split Right), "column" = stacked (Split Below). */
export type SplitDir = "row" | "column";

/** One step from a Split toward a child; a path from the root uniquely addresses any node. */
export type SplitStep = "first" | "second";
export type SplitPath = SplitStep[];

/** A terminal pane in the tree. */
export interface Leaf {
  kind: "leaf";
  paneId: PaneId;
}

/** An internal split of two subtrees along `dir`, `ratio` of the main axis going to `first`. */
export interface Split {
  kind: "split";
  dir: SplitDir;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = Leaf | Split;

/** A pixel rectangle in the tab content area. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One pane's solved geometry. */
export interface PaneRect {
  paneId: PaneId;
  rect: Rect;
}

/** One divider's solved geometry. */
export interface DividerRect {
  path: SplitPath;
  /** The thin visual line (1px along the main axis) at its current position. */
  rect: Rect;
  dir: SplitDir;
  /**
   * trmx-85: the ENCLOSING rect this split subdivides (origin + full main-axis length, BEFORE the
   * divider gap is carved). A pointer→ratio drag needs this: the ratio is defined over
   * `mainAxis(bounds) − min(dividerPx, mainAxis)`, matching solveRects' own `avail`.
   */
  bounds: Rect;
}

/** The full solved layout for a tree within some bounds. */
export interface SolvedLayout {
  panes: PaneRect[];
  dividers: DividerRect[];
}

/** Minimum fraction a split may allocate to either side (the numeric clamp for setRatio). */
export const MIN_RATIO = 0.05;

/** The default divider thickness (px) carved out of the bounds between the two sides. */
export const DEFAULT_DIVIDER_PX = 1;

/**
 * The usability floor on "unlimited" splitting: a pane may not shrink below this (px). The SINGLE
 * source for both the split guard (canSplit / App) and the FR-3.3 divider-drag clamp — no drift.
 */
export const MIN_PANE_PX: MinSize = { width: 80, height: 60 };

/** A fresh single-pane tree. */
export function leafNode(paneId: PaneId): Leaf {
  return { kind: "leaf", paneId };
}

/** True iff `node` is a Leaf carrying `paneId`. */
function isLeafOf(node: LayoutNode, paneId: PaneId): boolean {
  return node.kind === "leaf" && node.paneId === paneId;
}

/**
 * Replace the leaf for `paneId` with a 50/50 `dir` split. The existing pane keeps `first`; the new
 * pane is `second` (Right/Below place the new pane AFTER). Unknown paneId → the SAME tree (===).
 */
export function splitLeaf(
  tree: LayoutNode,
  paneId: PaneId,
  dir: SplitDir,
  newPaneId: PaneId,
): LayoutNode {
  if (tree.kind === "leaf") {
    if (tree.paneId !== paneId) return tree;
    return { kind: "split", dir, ratio: 0.5, first: tree, second: leafNode(newPaneId) };
  }
  const first = splitLeaf(tree.first, paneId, dir, newPaneId);
  if (first !== tree.first) return { ...tree, first };
  const second = splitLeaf(tree.second, paneId, dir, newPaneId);
  if (second !== tree.second) return { ...tree, second };
  return tree;
}

/** The nearest leaf of a subtree walking the `first` side — the focus target after a removal. */
export function firstLeaf(node: LayoutNode): PaneId {
  let n = node;
  while (n.kind === "split") n = n.first;
  return n.paneId;
}

/** The result of removing a leaf: the new tree (null if the tree emptied) + who to focus next. */
export interface RemoveResult {
  tree: LayoutNode | null;
  focusNext: PaneId | null;
}

/**
 * Remove the leaf for `paneId` with SIBLING PROMOTION: the removed leaf's sibling subtree replaces
 * the parent Split. `focusNext` = the sibling's nearest leaf (its firstLeaf). Removing the only leaf
 * → { tree: null, focusNext: null }. Unknown paneId → { tree (===), focusNext: null }.
 *
 * Invariant used below: in the recursive branch neither direct child IS the target leaf, so the
 * target sits ≥2 deep in a subtree that holds ≥2 leaves and therefore cannot collapse to null — so
 * `focusNext !== null` uniquely means "found & removed within this non-degenerate subtree".
 */
export function removeLeaf(tree: LayoutNode, paneId: PaneId): RemoveResult {
  if (tree.kind === "leaf") {
    return tree.paneId === paneId ? { tree: null, focusNext: null } : { tree, focusNext: null };
  }
  if (isLeafOf(tree.first, paneId)) {
    return { tree: tree.second, focusNext: firstLeaf(tree.second) };
  }
  if (isLeafOf(tree.second, paneId)) {
    return { tree: tree.first, focusNext: firstLeaf(tree.first) };
  }
  const inFirst = removeLeaf(tree.first, paneId);
  if (inFirst.focusNext !== null) {
    return { tree: { ...tree, first: inFirst.tree as LayoutNode }, focusNext: inFirst.focusNext };
  }
  const inSecond = removeLeaf(tree.second, paneId);
  if (inSecond.focusNext !== null) {
    return { tree: { ...tree, second: inSecond.tree as LayoutNode }, focusNext: inSecond.focusNext };
  }
  return { tree, focusNext: null };
}

// Recurse to the Split addressed by `path`, replacing its ratio; a path that doesn't land on a Split
// (too long, or points at a leaf) is a no-op that returns the SAME node so setRatio stays ===-safe.
function setRatioAt(node: LayoutNode, path: SplitPath, i: number, ratio: number): LayoutNode {
  if (i === path.length) {
    if (node.kind !== "split" || node.ratio === ratio) return node;
    return { ...node, ratio };
  }
  if (node.kind !== "split") return node;
  const step = path[i];
  const child = step === "first" ? node.first : node.second;
  const next = setRatioAt(child, path, i + 1, ratio);
  if (next === child) return node;
  return step === "first" ? { ...node, first: next } : { ...node, second: next };
}

/**
 * Set the ratio of the Split addressed by `path`, clamped to [MIN_RATIO, 1-MIN_RATIO] (a numeric
 * floor; the px-based minimum lives in canSplit / the FR-3.3 consumer). Consumed by FR-3.3.
 */
export function setRatio(tree: LayoutNode, path: SplitPath, ratio: number): LayoutNode {
  const clamped = Math.min(Math.max(ratio, MIN_RATIO), 1 - MIN_RATIO);
  return setRatioAt(tree, path, 0, clamped);
}

// Carve `bounds` for `node` into pane + divider rects, appending to the accumulators. Integer pixels;
// the first side gets round(avail * ratio), the second gets the exact remainder, so the two sides +
// the divider tile the bounds with no gap or overlap.
function walkRects(
  node: LayoutNode,
  rect: Rect,
  path: SplitPath,
  divider: number,
  panes: PaneRect[],
  dividers: DividerRect[],
): void {
  if (node.kind === "leaf") {
    panes.push({ paneId: node.paneId, rect });
    return;
  }
  if (node.dir === "row") {
    // Cap the divider to the axis so a rect narrower than the divider still tiles (no overflow):
    // firstW + gap + secondW == rect.width for any width ≥ 0.
    const gap = Math.min(divider, rect.width);
    const avail = rect.width - gap;
    const firstW = Math.round(avail * node.ratio);
    const secondW = avail - firstW;
    dividers.push({
      path,
      dir: node.dir,
      rect: { x: rect.x + firstW, y: rect.y, width: gap, height: rect.height },
      bounds: rect,
    });
    walkRects(node.first, { x: rect.x, y: rect.y, width: firstW, height: rect.height }, [...path, "first"], divider, panes, dividers);
    walkRects(node.second, { x: rect.x + firstW + gap, y: rect.y, width: secondW, height: rect.height }, [...path, "second"], divider, panes, dividers);
  } else {
    const gap = Math.min(divider, rect.height);
    const avail = rect.height - gap;
    const firstH = Math.round(avail * node.ratio);
    const secondH = avail - firstH;
    dividers.push({
      path,
      dir: node.dir,
      rect: { x: rect.x, y: rect.y + firstH, width: rect.width, height: gap },
      bounds: rect,
    });
    walkRects(node.first, { x: rect.x, y: rect.y, width: rect.width, height: firstH }, [...path, "first"], divider, panes, dividers);
    walkRects(node.second, { x: rect.x, y: rect.y + firstH + gap, width: rect.width, height: secondH }, [...path, "second"], divider, panes, dividers);
  }
}

/**
 * Solve the pixel geometry for `tree` within `bounds`. Deterministic, pure. Every leaf appears
 * exactly once in `panes`; `dividers` carry the gap between each split's sides. `divider` px are
 * carved out of the main axis so panes + dividers tile the bounds.
 */
export function solveRects(tree: LayoutNode, bounds: Rect, divider = DEFAULT_DIVIDER_PX): SolvedLayout {
  const panes: PaneRect[] = [];
  const dividers: DividerRect[] = [];
  walkRects(tree, bounds, [], divider, panes, dividers);
  return { panes, dividers };
}

/** Every paneId in DFS order (first before second). */
export function leaves(tree: LayoutNode): PaneId[] {
  const out: PaneId[] = [];
  const walk = (n: LayoutNode): void => {
    if (n.kind === "leaf") {
      out.push(n.paneId);
      return;
    }
    walk(n.first);
    walk(n.second);
  };
  walk(tree);
  return out;
}

/**
 * The DFS pane order — the seam FR-3.5 (directional keyboard nav) will consume. Exposed here so the
 * tree-walking lives in one place; directional focus itself ships in trmx-86.
 */
export const paneOrder = leaves;

/** The path to `paneId`'s leaf, or null if absent. */
export function findLeaf(tree: LayoutNode, paneId: PaneId): SplitPath | null {
  const walk = (n: LayoutNode, path: SplitPath): SplitPath | null => {
    if (n.kind === "leaf") return n.paneId === paneId ? path : null;
    return walk(n.first, [...path, "first"]) ?? walk(n.second, [...path, "second"]);
  };
  return walk(tree, []);
}

/** A minimum pane size in pixels (the usability floor on "unlimited" splitting). */
export interface MinSize {
  width: number;
  height: number;
}

/**
 * Pure guard: would splitting `paneId` along `dir` within `bounds` leave BOTH resulting halves at
 * least `min`? Consulted before splitLeaf; a false result → a soft no-op/beep (the split is refused).
 * Unknown paneId → false.
 */
export function canSplit(
  tree: LayoutNode,
  paneId: PaneId,
  dir: SplitDir,
  bounds: Rect,
  min: MinSize,
  divider = DEFAULT_DIVIDER_PX,
): boolean {
  const pane = solveRects(tree, bounds, divider).panes.find((p) => p.paneId === paneId);
  if (!pane) return false;
  const r = pane.rect;
  if (dir === "row") {
    const avail = r.width - divider;
    if (avail < 0) return false;
    const half = Math.floor(avail / 2);
    return half >= min.width && avail - half >= min.width && r.height >= min.height;
  }
  const avail = r.height - divider;
  if (avail < 0) return false;
  const half = Math.floor(avail / 2);
  return half >= min.height && avail - half >= min.height && r.width >= min.width;
}
