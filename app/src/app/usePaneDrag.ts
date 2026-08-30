// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: the divider drag (trmx-85) and the trmx-100 Cmd-drag pane re-dock. Pure logic.
//
// Every piece of drag STATE and every drag REF stays root-owned — `paneDragging`, `dropPreview`,
// `dragDir`, `dragRef`, `pickupRef`, `frameCancelRef` and the rest. The JSX reads several of them
// directly, so they could not move even if the hook wanted them. E17 also stays inline at the root:
// it pairs `frameCancelRef` cleanup with `runtimes.clearAllTimers()`, and that pairing is the
// StrictMode invariant trmx-248 documented.

import type { Dispatch, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { grabOffsetOf, ratioForDrag, RESET_RATIO } from "../panes/dividerDrag";
import { dropZone, type DropZone } from "../panes/dropZone";
import {
  canDropEdge,
  solveRects,
  type DividerRect,
  type PaneId,
  type Rect,
  type SplitDir,
} from "../panes/layoutTree";
import type { TabsAction, TabsState } from "../tabs/tabState";
import type { PaneRuntimes } from "./paneRuntime";

type DragState = {
  pointerId: number;
  tabId: number;
  path: DividerRect["path"];
  dir: SplitDir;
  bounds: Rect;
  grabOffset: number;
  contentLeft: number;
  contentTop: number;
} | null;
type Pickup = {
  pointerId: number; tabId: number; paneId: PaneId;
  originX: number; originY: number; active: boolean;
} | null;

export type PaneDragDeps = {
  stateRef: { current: TabsState };
  runtimesRef: { current: PaneRuntimes };
  boundsRef: { current: Rect };
  contentRef: { current: HTMLDivElement | null };
  dispatch: Dispatch<TabsAction>;
  // root-owned drag refs — mutated here, declared there
  dragScheduleRef: { current: (cb: () => void) => () => void };
  dragRef: { current: DragState };
  pendingRatioRef: { current: number | null };
  frameCancelRef: { current: (() => void) | null };
  pickupRef: { current: Pickup };
  paneDragFrameRef: { current: (() => void) | null };
  pendingPointerRef: { current: { x: number; y: number } | null };
  suppressClickRef: { current: boolean };
  // root-owned drag state setters
  setDragDir: (dir: SplitDir | null) => void;
  setPaneDragging: (on: boolean) => void;
  setDropPreview: (next: { paneId: PaneId; zone: DropZone } | null) => void;
};

export type PaneDrag = {
  endDrag: (commit: boolean) => void;
  onDividerPointerDown: (tabId: number, d: DividerRect) => (e: ReactPointerEvent) => void;
  onDividerPointerMove: (e: ReactPointerEvent) => void;
  onDividerPointerUp: (e: ReactPointerEvent) => void;
  onDividerPointerCancel: (e: ReactPointerEvent) => void;
  onDividerDoubleClick: (tabId: number, path: DividerRect["path"]) => (e: ReactMouseEvent) => void;
  onPanePointerDownCapture: (tabId: number, paneId: PaneId) => (e: ReactPointerEvent) => void;
  onPanePointerMoveCapture: (e: ReactPointerEvent) => void;
  onPanePointerUpCapture: (e: ReactPointerEvent) => void;
  onPanePointerCancel: (e: ReactPointerEvent) => void;
  onPaneClickCapture: (e: ReactMouseEvent) => void;
  /** E18's body — the Esc-cancels-drag key handler. Takes `paneDragging` (its dep) and returns cleanup. */
  onDragKey: (paneDragging: boolean) => (() => void) | undefined;
  /** E19's body — cancels a queued frame on unmount. RETURNS the cleanup; it must not cancel on mount. */
  cancelPendingFrame: () => void;
};

export function usePaneDrag(deps: PaneDragDeps): PaneDrag {
  const {
    stateRef, runtimesRef, boundsRef, contentRef, dispatch,
    dragScheduleRef, dragRef, pendingRatioRef, frameCancelRef,
    pickupRef, paneDragFrameRef, pendingPointerRef, suppressClickRef,
    setDragDir, setPaneDragging, setDropPreview,
  } = deps;
  const PANE_DRAG_SLOP = 4;

  // Dispatch the latest dragged ratio at most once per frame (coalesce raw pointermoves).
  const scheduleRatioFlush = () => {
    if (frameCancelRef.current) return; // a frame is already pending — coalesce into it
    frameCancelRef.current = dragScheduleRef.current(() => {
      frameCancelRef.current = null;
      const d = dragRef.current;
      const ratio = pendingRatioRef.current;
      if (d && ratio !== null) dispatch({ kind: "setPaneRatio", tabId: d.tabId, path: d.path, ratio });
    });
  };

  // End the drag. `commit` (pointerup) APPLIES the latest pending ratio synchronously first — a quick
  // drag-and-release within a single animation frame must not be lost — whereas the abort paths
  // (pointercancel / lostpointercapture / unmount) skip the commit. Either way the pending frame is
  // cancelled and state cleared, so no dispatch ever lands after the drag has ended.
  const endDrag = (commit: boolean) => {
    if (commit) {
      const d = dragRef.current;
      const ratio = pendingRatioRef.current;
      if (d && ratio !== null) dispatch({ kind: "setPaneRatio", tabId: d.tabId, path: d.path, ratio });
    }
    if (frameCancelRef.current) {
      frameCancelRef.current();
      frameCancelRef.current = null;
    }
    pendingRatioRef.current = null;
    dragRef.current = null;
    setDragDir(null);
  };

  const pointerMainOf = (e: ReactPointerEvent, dir: SplitDir, left: number, top: number) =>
    dir === "row" ? e.clientX - left : e.clientY - top;

  // pointerdown records the grab offset (pointer − the visual line's leading edge) so the divider does
  // not jump to the cursor when the grab landed beside the 1px line inside the widened hit area.
  const onDividerPointerDown = (tabId: number, d: DividerRect) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // a divider grab must never focus a pane
    const contentRect = contentRef.current?.getBoundingClientRect();
    const contentLeft = contentRect?.left ?? 0;
    const contentTop = contentRect?.top ?? 0;
    const pointerMain = pointerMainOf(e, d.dir, contentLeft, contentTop);
    const leadingEdge = d.dir === "row" ? d.rect.x : d.rect.y;
    dragRef.current = {
      pointerId: e.pointerId,
      tabId,
      path: d.path,
      dir: d.dir,
      bounds: d.bounds,
      grabOffset: grabOffsetOf(pointerMain, leadingEdge),
      contentLeft,
      contentTop,
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDragDir(d.dir);
  };

  const onDividerPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const pointerMain = pointerMainOf(e, d.dir, d.contentLeft, d.contentTop);
    pendingRatioRef.current = ratioForDrag({ pointerMain, grabOffset: d.grabOffset, bounds: d.bounds, dir: d.dir });
    scheduleRatioFlush();
  };

  const onDividerPointerUp = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    endDrag(true); // commit the final drag position
  };

  // pointercancel / lostpointercapture ABORT the drag (no commit) — no stuck overlay / stale frame.
  const onDividerPointerCancel = () => endDrag(false);

  const onDividerDoubleClick = (tabId: number, path: DividerRect["path"]) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    dispatch({ kind: "setPaneRatio", tabId, path, ratio: RESET_RATIO });
  };

  // Cleanup on unmount: a mid-drag unmount must not leave a queued frame to dispatch into a dead
  // reducer, and (trmx-91/99) no pending activity OR flash timer may fire a setState after unmount.

  // Which pane + zone the pointer is over (content-relative coords, solveRects space). Null when outside
  // any pane, over the SOURCE pane itself, or on an edge whose 50/50 insert would under-size a pane.
  const computeDropTarget = (clientX: number, clientY: number): { paneId: PaneId; zone: DropZone } | null => {
    const p = pickupRef.current;
    if (!p) return null;
    const tab = stateRef.current.tabs.find((t) => t.tabId === p.tabId);
    if (!tab) return null;
    const contentRect = contentRef.current?.getBoundingClientRect();
    const cx = clientX - (contentRect?.left ?? 0);
    const cy = clientY - (contentRect?.top ?? 0);
    const solved = solveRects(tab.tree, boundsRef.current);
    const hit = solved.panes.find(
      (pr) =>
        cx >= pr.rect.x &&
        cx < pr.rect.x + pr.rect.width &&
        cy >= pr.rect.y &&
        cy < pr.rect.y + pr.rect.height,
    );
    if (!hit || hit.paneId === p.paneId) return null; // outside, or the source pane itself
    const zone = dropZone(hit.rect, { x: cx, y: cy });
    if (zone !== "center" && !canDropEdge(tab.tree, hit.paneId, zone, boundsRef.current)) return null;
    return { paneId: hit.paneId, zone };
  };

  const schedulePaneHoverFlush = () => {
    if (paneDragFrameRef.current) return; // coalesce into the pending frame
    paneDragFrameRef.current = dragScheduleRef.current(() => {
      paneDragFrameRef.current = null;
      const pt = pendingPointerRef.current;
      if (pt) setDropPreview(computeDropTarget(pt.x, pt.y));
    });
  };

  const endPaneDrag = (commit: boolean, target?: { paneId: PaneId; zone: DropZone } | null) => {
    const p = pickupRef.current;
    if (paneDragFrameRef.current) {
      paneDragFrameRef.current();
      paneDragFrameRef.current = null;
    }
    if (commit && p && target) {
      dispatch({
        kind: "redockPane",
        tabId: p.tabId,
        paneId: p.paneId,
        targetPaneId: target.paneId,
        zone: target.zone,
      });
    }
    // An abort path (pointercancel / lostpointercapture / Esc / unmount) produces NO trailing click, so the
    // click-swallow must be disarmed here or it would eat the next unrelated pane click. On a `commit`
    // (pointerup) the synthetic click DOES follow and onPaneClickCapture clears the flag itself.
    if (!commit) suppressClickRef.current = false;
    pickupRef.current = null;
    pendingPointerRef.current = null;
    setDropPreview(null);
    setPaneDragging(false);
  };

  const onPanePointerDownCapture = (tabId: number, paneId: PaneId) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || !e.metaKey) return; // only ⌘ + primary starts a pickup candidate
    suppressClickRef.current = false; // clear any stale swallow from a prior gesture that never clicked
    // Record the origin but do NOT preventDefault yet — a sub-slop ⌘-click must still open an OSC 8 link.
    pickupRef.current = { pointerId: e.pointerId, tabId, paneId, originX: e.clientX, originY: e.clientY, active: false };
  };

  const onPanePointerMoveCapture = (e: ReactPointerEvent) => {
    const p = pickupRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    if (!p.active) {
      if (Math.abs(e.clientX - p.originX) < PANE_DRAG_SLOP && Math.abs(e.clientY - p.originY) < PANE_DRAG_SLOP) {
        return; // still under the slop threshold — could be a click
      }
      // Crossed slop → commit to a pickup: capture the pointer, raise the shield, drop any nascent xterm
      // selection the initial mousedown started, and arm the click swallow so xterm's link never fires.
      p.active = true;
      // setPointerCapture throws (InvalidStateError) if the pointer isn't active — guard so a synthetic
      // event sequence (tests) never breaks the gesture.
      try {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* no active pointer to capture — the shield still isolates xterm */
      }
      (runtimesRef.current.get(p.paneId)?.handle?.terminal as unknown as { clearSelection?: () => void } | undefined)?.clearSelection?.();
      suppressClickRef.current = true;
      setPaneDragging(true);
    }
    e.preventDefault();
    e.stopPropagation();
    pendingPointerRef.current = { x: e.clientX, y: e.clientY };
    schedulePaneHoverFlush();
  };

  const onPanePointerUpCapture = (e: ReactPointerEvent) => {
    const p = pickupRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    if (!p.active) {
      pickupRef.current = null; // a sub-slop ⌘-click — let it through (the link opens)
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* not captured — nothing to release */
    }
    // Synchronously compute the FINAL zone from the release coords — a quick release before the rAF frame
    // fired must not commit a stale/null preview (the divider-drag guarantee).
    endPaneDrag(true, computeDropTarget(e.clientX, e.clientY));
  };

  const onPanePointerCancel = () => {
    if (pickupRef.current?.active) endPaneDrag(false);
    else pickupRef.current = null;
  };

  // Swallow the one synthetic click after a real pickup so xterm's OSC 8 link `activate` never fires.
  const onPaneClickCapture = (e: ReactMouseEvent) => {
    if (suppressClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressClickRef.current = false;
    }
  };

  // Esc cancels an in-flight pane drag (tree + focus unchanged). Only while dragging.

  const onDragKey = (paneDragging: boolean) => {
    if (!paneDragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        endPaneDrag(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  };

  const cancelPendingFrame = () => {
    return () => {
      if (paneDragFrameRef.current) paneDragFrameRef.current();
    };
  };

  return {
    endDrag, onDividerPointerDown, onDividerPointerMove, onDividerPointerUp, onDividerPointerCancel,
    onDividerDoubleClick, onPanePointerDownCapture, onPanePointerMoveCapture,
    onPanePointerUpCapture, onPanePointerCancel, onPaneClickCapture,
    onDragKey, cancelPendingFrame,
  };
}
