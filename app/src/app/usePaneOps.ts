// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: the pane/tab operations every verb ultimately calls — create, split, navigate, close,
// and the trmx-93 "run in a fresh surface" path. Pure logic: no state, no refs, no effects.
//
// `createTab` is deliberately NOT returned: a symbol walk shows it never escapes this region, so it
// stays internal. `runScriptInSurface` IS returned — the JSX reads it, which an earlier draft of the
// contract missed.

import type { Dispatch } from "react";
import { MIN_PANE_PX, solveRects, type PaneId, type Rect, type SplitDir } from "../panes/layoutTree";
import { nextPane, paneInDirection, type Direction } from "../panes/paneNav";
import type { ScriptEntry } from "../scripts/scriptsBackend";
import { canSplitFocused, type Tab, type TabsAction, type TabsState } from "../tabs/tabState";
import type { CloseOpts } from "./closeContracts";
import type { IdReservation } from "../tabs/idReservation";
import type { PaneRuntime, PaneRuntimes } from "./paneRuntime";

export type PaneOpsDeps = {
  stateRef: { current: TabsState };
  runtimesRef: { current: PaneRuntimes };
  boundsRef: { current: Rect };
  createTabRef: { current: (cwdOverride?: string) => { tabId: number; paneId: number } };
  deliverServicePathsRef: { current: (paths: string[]) => void };
  dispatch: Dispatch<TabsAction>;
  seedPaneField: <K extends keyof PaneRuntime>(paneId: PaneId, field: K, value: PaneRuntime[K]) => void;
  /** Non-null: the root lazily initialises `reservationRef` before this hook is called. */
  reservation: IdReservation;
  close: {
    closePaneInternal: (tabId: number, paneId: PaneId, opts?: CloseOpts) => void;
    closeTabInternal: (tabId: number, opts?: CloseOpts) => void;
  };
};

export type PaneOps = {
  getActiveTab: () => Tab | undefined;
  requestNewTab: () => void;
  requestSplit: (dir: "right" | "below") => { paneId: number } | null;
  requestPaneNav: (
    action: { kind: "nav-dir"; dir: Direction } | { kind: "nav-cycle"; delta: 1 | -1 },
  ) => void;
  requestCloseActive: (origin?: "user" | "remote") => void;
  requestCloseTab: (tabId: number) => void;
  runScriptInSurface: (entry: ScriptEntry, surface: "tab" | "right" | "below") => void;
  deliverServicePaths: (paths: string[]) => void;
};

export function usePaneOps(deps: PaneOpsDeps): PaneOps {
  const {
    stateRef, runtimesRef, boundsRef, createTabRef, deliverServicePathsRef,
    dispatch, seedPaneField, reservation, close,
  } = deps;
  const { closePaneInternal, closeTabInternal } = close;

  const createTab = (cwdOverride?: string): { tabId: number; paneId: number } => {
    const s = stateRef.current;
    const { tabId, paneId } = reservation.reserveTab();
    const activeTab =
      s.activeTabId !== null ? s.tabs.find((t) => t.tabId === s.activeTabId) : undefined;
    const activeStore = activeTab ? runtimesRef.current.get(activeTab.focusedPaneId)?.cwd : undefined;
    seedPaneField(paneId, "pendingCwd", cwdOverride ?? activeStore?.get() ?? undefined);
    dispatch({ kind: "openTab" });
    return { tabId, paneId };
  };
  createTabRef.current = createTab;
  // The public creator stays PARAMETERLESS: it is wired as an event handler (the tab strip's
  // "+" onClick), and a parameter would receive the click event (trmx-224 regression).
  const requestNewTab = () => createTab();

  // trmx-84: split the active tab's focused pane. `right` → a row split (side by side), `below` → a
  // column split (stacked). Refused (soft no-op) when the result would go below the min pane size.
  // The new pane inherits the focused pane's cwd and takes focus (readyFor focuses it on mount).
  const requestSplit = (dir: "right" | "below"): { paneId: number } | null => {
    const s = stateRef.current;
    if (s.activeTabId === null) return null;
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId);
    if (!tab) return null;
    const treeDir: SplitDir = dir === "right" ? "row" : "column";
    if (!canSplitFocused(tab, treeDir, boundsRef.current, MIN_PANE_PX)) return null; // won't fit — no-op
    // trmx-224: reserve AFTER the refusal checks — a refused split reserves nothing (the
    // 1:1 reservation-per-dispatch pairing; splitPane advances only the pane counter).
    const { paneId } = reservation.reservePane();
    const focusedStore = runtimesRef.current.get(tab.focusedPaneId)?.cwd;
    seedPaneField(paneId, "pendingCwd", focusedStore?.get() ?? undefined);
    dispatch({ kind: "splitPane", tabId: tab.tabId, dir: treeDir });
    return { paneId };
  };

  // trmx-93 (FR-5): run `entry` in a fresh surface. The chosen script is stored in pendingScriptRef
  // keyed by the upcoming pane's (predictable) id SYNCHRONOUSLY before the creating dispatch — the
  // same nextPaneId requestNewTab/requestSplit seed pendingCwdRef with, so cwd inheritance survives
  // and the new pane's attach sources the script. For a split that won't fit we bail WITHOUT setting
  // the pending script, so a no-op split can't leave a stale entry for the next pane to pick up.
  const runScriptInSurface = (entry: ScriptEntry, surface: "tab" | "right" | "below") => {
    // trmx-224: creators return their RESERVED ids — the wrapper never predicts (a delegating
    // read would double-reserve). Keying happens right after the call, in the same synchronous
    // section, well before any attach; a refused split returns null and nothing is keyed, so
    // the old bail-before-set stale-entry dance is now structural.
    const pending = Promise.resolve<{ sourceLine: string } | null>({ sourceLine: entry.sourceLine });
    const opened = surface === "tab" ? requestNewTab() : requestSplit(surface);
    if (opened) seedPaneField(opened.paneId, "pendingScript", pending);
  };

  // trmx-224: deliver one service batch — ONE synchronous block (reserve→seed→dispatch per
  // path via requestNewTab), then focus the FIRST delivered tab (each openTab activates the
  // appended tab, so without this the LAST path would win). Any `await` inside this block
  // would reopen the prediction-interleaving race class — keep it unbroken.
  const deliverServicePaths = (paths: string[]) => {
    let firstTabId: number | null = null;
    for (const path of paths) {
      const opened = createTab(path);
      if (firstTabId === null) firstTabId = opened.tabId;
    }
    if (firstTabId !== null) dispatch({ kind: "activateTab", tabId: firstTabId });
  };
  deliverServicePathsRef.current = deliverServicePaths;

  // trmx-86 (FR-3.5): move focus between panes of the ACTIVE tab. `nav-dir` picks the geometrically
  // nearest pane via paneInDirection over the current solved rects; `nav-cycle` steps the leaves order.
  // A null / same-as-current target is a no-op. Shared by the keymap AND the Window-menu verbs, and kept
  // action-shaped so FR-9's command registry can lift it directly.
  const requestPaneNav = (
    action: { kind: "nav-dir"; dir: Direction } | { kind: "nav-cycle"; delta: 1 | -1 },
  ) => {
    const s = stateRef.current;
    if (s.activeTabId === null) return;
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId);
    if (!tab) return;
    const target =
      action.kind === "nav-dir"
        ? paneInDirection(solveRects(tab.tree, boundsRef.current).panes, tab.focusedPaneId, action.dir)
        : nextPane(tab.tree, tab.focusedPaneId, action.delta);
    if (target !== null && target !== tab.focusedPaneId) {
      dispatch({ kind: "focusPane", tabId: tab.tabId, paneId: target });
    }
  };

  // ⌘W / menu "close": close the active tab's FOCUSED pane (pane → tab → window). `origin`
  // (trmx-144) tags who asked — the dispatcher injects "remote" for control-channel requests, so
  // those skip the confirm gate; everything else defaults to "user".
  const requestCloseActive = (origin?: "user" | "remote") => {
    const s = stateRef.current;
    if (s.activeTabId === null) return;
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId);
    if (!tab) return;
    closePaneInternal(tab.tabId, tab.focusedPaneId, { origin: origin ?? "user" });
  };

  // The tab-strip × closes the WHOLE tab (all its panes), distinct from the ⌘W pane precedence.
  const requestCloseTab = (tabId: number) => closeTabInternal(tabId);

  // trmx-94 (FR-9.1): the command platform. The CommandContext maps each command's `run` onto the
  // existing request* funcs + a few new capabilities; menu verbs, keymap hits, and palette picks ALL
  // route through `dispatch` (the single spine). The dispatcher is created ONCE (MRU persists) with a
  // forwarding ctx that always calls the CURRENT request funcs via a ref.
  const getActiveTab = () => {
    const s = stateRef.current;
    return s.activeTabId !== null ? s.tabs.find((t) => t.tabId === s.activeTabId) : undefined;
  };

  return {
    getActiveTab, requestNewTab, requestSplit, requestPaneNav,
    requestCloseActive, requestCloseTab, runScriptInSurface, deliverServicePaths,
  };
}
