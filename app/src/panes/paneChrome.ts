// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-87 (FR-3.6) + trmx-175: the pure "which part of each divider is active" computation for the Kitty
// multi-pane look. A divider is drawn in the focused-pane border color only over the SEGMENT where it
// actually borders the focused pane — the perpendicular overlap between the (single, contiguous) focused
// rect and the divider. `activeDividerSegments` returns that span per divider; `activeDividerKeys` is the
// set of dividers that have one. trmx-175 fixed the earlier whole-divider approximation, which colored a
// full-length divider along its ENTIRE length when only a sub-span bordered the focused pane (so the part
// between two unfocused panes was wrongly active). Pure + React-free like layoutTree/paneNav so it is
// unit-testable headless; App renders an inactive base line + an active overlay over the segment (a
// style flip — no re-layout, no terminal touch).

import type { DividerRect, PaneId, PaneRect, Rect } from "./layoutTree";

/** The stable key App renders for a divider (its `divider-${key}` React key + data-testid base). */
export function dividerKey(path: DividerRect["path"]): string {
  return path.join("-") || "root";
}

/** The active sub-span of a divider: `offset` px from the divider's start along its long axis, `length` px. */
export interface ActiveSegment {
  offset: number;
  length: number;
}

// The span of divider `d` that borders the focused rect `f`: `d` must be edge-adjacent to `f` AND share a
// perpendicular span (their overlap interval). Returns null when `d` does not border `f`. Because `f` is a
// single rect, that overlap is one contiguous interval — a divider has at most one active segment. The
// span runs along the divider's long axis (y for a "row"/vertical divider, x for a "column"/horizontal one).
function activeSegment(f: Rect, d: DividerRect): ActiveSegment | null {
  if (d.dir === "row") {
    // Vertical divider (long axis = y): adjacent to the focused pane's left OR right edge.
    const adjacent = d.rect.x + d.rect.width === f.x || d.rect.x === f.x + f.width;
    if (!adjacent) return null;
    const y0 = Math.max(f.y, d.rect.y);
    const y1 = Math.min(f.y + f.height, d.rect.y + d.rect.height);
    return y1 > y0 ? { offset: y0 - d.rect.y, length: y1 - y0 } : null;
  }
  // Horizontal divider (long axis = x): adjacent to the focused pane's top OR bottom edge.
  const adjacent = d.rect.y + d.rect.height === f.y || d.rect.y === f.y + f.height;
  if (!adjacent) return null;
  const x0 = Math.max(f.x, d.rect.x);
  const x1 = Math.min(f.x + f.width, d.rect.x + d.rect.width);
  return x1 > x0 ? { offset: x0 - d.rect.x, length: x1 - x0 } : null;
}

/**
 * The active SEGMENT of every divider that borders the focused pane, keyed by `dividerKey`. App renders
 * each as an active-colored (`--tx-pane-active-border`) overlay over the inactive base line, covering ONLY
 * the returned span (so a full-height divider next to a bottom pane is blue only over that bottom half).
 * Empty for an unknown focus or a single-pane tab (which has no dividers).
 */
export function activeDividerSegments(
  panes: PaneRect[],
  dividers: DividerRect[],
  focusedPaneId: PaneId,
): Map<string, ActiveSegment> {
  const focused = panes.find((p) => p.paneId === focusedPaneId);
  const out = new Map<string, ActiveSegment>();
  if (!focused) return out;
  for (const d of dividers) {
    const seg = activeSegment(focused.rect, d);
    if (seg) out.set(dividerKey(d.path), seg);
  }
  return out;
}

/**
 * The keys of the dividers that OUTLINE the focused pane (i.e. have an active segment). A convenience view
 * over `activeDividerSegments` — a divider is "active" iff it borders the focused pane somewhere.
 */
export function activeDividerKeys(
  panes: PaneRect[],
  dividers: DividerRect[],
  focusedPaneId: PaneId,
): Set<string> {
  return new Set(activeDividerSegments(panes, dividers, focusedPaneId).keys());
}
