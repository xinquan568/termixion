// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-74/75/84: the pure tab model — a reducer over TabsState with NO React import, so every
// transition the tab bar + panes need is unit-testable headless and the React layer stays a thin
// `useReducer` shell.
//
// trmx-84 (FR-3.1/3.2) grows a tab from a single pane into a PANE TREE: a tab owns a pure
// `layoutTree` (panes/layoutTree.ts), a `focusedPaneId`, and a `panes` record of per-pane state
// (session + title sources). A pane is exactly what a tab's single surface was before (trmx-74),
// so all the session/title machinery simply moves from tab scope to PANE scope. The tab's rendered
// `title` is DERIVED — always the FOCUSED pane's effective title — so the strip/window still
// consume one string, and it switches source as focus moves between panes.
//
// Conventions (all iTerm2-modeled):
// - Tab ids AND pane ids are MONOTONIC and never reused (`nextTabId`/`nextPaneId` only increment),
//   so a stale id can never alias a new tab/pane. Pane ids are GLOBAL across tabs, so the render
//   layer's paneId-keyed maps never collide.
// - A pane is born session-less (`sessionId: null`); the async open_pty resolution attaches the
//   session later via `attachSession`. If the pane/tab died in between, attach is a no-op and the
//   CALLER disposes the orphan session (the reducer never owns backend resources).
// - Closing the ACTIVE tab activates the RIGHT neighbor, else the LEFT one, else nothing.
// - `selectIndex` 8 (⌘9) means the LAST tab regardless of count.
// - Every no-op returns the IDENTICAL state object (===), so a React `useReducer` consumer skips
//   the re-render and tests can pin no-op-ness exactly.
// - trmx-75 titles are layered SOURCES (manual > osc > process > fallback, tabTitle.ts), now held
//   PER PANE; every sources change recomputes that pane's `title`, and if it is the focused pane,
//   the tab's derived `title` too. A background pane's title change never moves the tab label.
// - trmx-90 adds a per-pane `badge`: an ephemeral, session-lifetime overlay label — a SINGLE opaque
//   slot (last-write-wins, NOT a source ladder like the title). It is orthogonal to the title:
//   setting/clearing a badge never moves the tab label, even on the focused pane.
// - Pane ORDER always comes from the layout tree (`leaves`), never `Object.keys(panes)` (numeric
//   object keys enumerate string-coerced in ascending order, which is NOT layout order).

import { effectiveTitle, sanitizeTitle, type TitleSources } from "./tabTitle";
import {
  canSplit as canSplitTree,
  leafNode,
  leaves,
  removeLeaf,
  setRatio as setRatioTree,
  splitLeaf,
  type LayoutNode,
  type MinSize,
  type PaneId,
  type Rect,
  type SplitDir,
  type SplitPath,
} from "../panes/layoutTree";

/** One pane: the backend session it is bound to (null while opening), its layered title + badge. */
export interface PaneState {
  sessionId: number | null;
  titleSources: TitleSources;
  /** The pane's effective title — always `effectiveTitle(titleSources)`. */
  title: string;
  /**
   * trmx-90: an ephemeral, session-lifetime overlay label (undefined = no badge). A single OPAQUE
   * slot — last-write-wins, NOT a source ladder like the title. Not persisted; orthogonal to `title`
   * (setting/clearing it never moves the derived tab label).
   */
  badge?: string;
}

/** One tab: a stable identity, the pure pane tree, the focused pane, per-pane state, derived title. */
export interface Tab {
  tabId: number;
  tree: LayoutNode;
  focusedPaneId: PaneId;
  panes: Record<PaneId, PaneState>;
  /** Derived: the FOCUSED pane's effective title — the ONE string the strip/window consume. */
  title: string;
}

/** The whole tab strip: ordered tabs, the active tab's id (null when empty), and the id counters. */
export interface TabsState {
  tabs: Tab[];
  activeTabId: number | null;
  nextTabId: number;
  nextPaneId: number;
}

/** Every transition the tab strip + panes support — a discriminated union over `kind`. */
export type TabsAction =
  | { kind: "openTab"; title?: string }
  // trmx-84: session attach is now PER PANE (a tab has many).
  | { kind: "attachSession"; tabId: number; paneId: number; sessionId: number; title: string }
  // trmx-75/84: set (string) or clear (null) one of a PANE's three overridable title slots.
  | {
      kind: "setTitleSource";
      tabId: number;
      paneId: number;
      source: "manual" | "osc" | "process";
      value: string | null;
    }
  | { kind: "closeTab"; tabId: number }
  | { kind: "activateTab"; tabId: number }
  | { kind: "nextTab" }
  | { kind: "prevTab" }
  | { kind: "selectIndex"; index: number }
  | { kind: "moveTab"; from: number; to: number }
  // trmx-84 (FR-3.1/3.2): pane transitions.
  | { kind: "splitPane"; tabId: number; dir: SplitDir }
  | { kind: "closePane"; tabId: number; paneId: number }
  | { kind: "focusPane"; tabId: number; paneId: number }
  | { kind: "setPaneRatio"; tabId: number; path: SplitPath; ratio: number }
  // trmx-90: set (string) or clear (null) a PANE's ephemeral badge — last-write-wins, title-independent.
  | { kind: "setBadge"; tabId: number; paneId: number; badge: string | null };

/** The empty strip: no tabs, nothing active, tab AND pane ids starting at 1. */
export function initialTabsState(): TabsState {
  return { tabs: [], activeTabId: null, nextTabId: 1, nextPaneId: 1 };
}

// A fresh pane: session-less unless given one, its fallback seeded from `title` (junk → "Shell").
function makePane(sessionId: number | null, title: string): PaneState {
  const titleSources: TitleSources = { fallback: sanitizeTitle(title) || "Shell" };
  return { sessionId, titleSources, title: effectiveTitle(titleSources) };
}

// Activate `tabId` if it differs from the current active — shared by activate/next/prev/select so
// every "activation didn't change" path is the same `===` no-op.
function withActive(state: TabsState, tabId: number): TabsState {
  return state.activeTabId === tabId ? state : { ...state, activeTabId: tabId };
}

// Replace one tab in the ordered list (identity-preserving for the others).
function replaceTab(state: TabsState, tabId: number, nextTab: Tab): TabsState {
  return { ...state, tabs: state.tabs.map((t) => (t.tabId === tabId ? nextTab : t)) };
}

// Swap paneId's PaneState in `tab`, recomputing the tab's DERIVED title only when the focused pane
// changed — so a background pane's title update never moves the tab label (background isolation).
function replacePane(state: TabsState, tab: Tab, paneId: PaneId, nextPane: PaneState): TabsState {
  const panes = { ...tab.panes, [paneId]: nextPane };
  const title = paneId === tab.focusedPaneId ? nextPane.title : tab.title;
  return replaceTab(state, tab.tabId, { ...tab, panes, title });
}

/** Reduce one action. Pure: never mutates `state`; every no-op returns `state` itself (===). */
export function reduceTabs(state: TabsState, action: TabsAction): TabsState {
  switch (action.kind) {
    case "openTab": {
      const paneId = state.nextPaneId;
      const pane = makePane(null, action.title ?? "");
      const tab: Tab = {
        tabId: state.nextTabId,
        tree: leafNode(paneId),
        focusedPaneId: paneId,
        panes: { [paneId]: pane },
        title: pane.title,
      };
      return {
        tabs: [...state.tabs, tab],
        activeTabId: tab.tabId,
        nextTabId: state.nextTabId + 1,
        nextPaneId: state.nextPaneId + 1,
      };
    }

    case "attachSession": {
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state;
      const pane = tab.panes[action.paneId];
      if (!pane) return state; // dead/unknown pane — caller disposes the orphan session
      // The session title refreshes the FALLBACK slot only — never demoting a manual/OSC title that
      // raced ahead of this async resolution. Junk (empty after sanitize) keeps the prior fallback.
      const fallback = sanitizeTitle(action.title);
      const titleSources: TitleSources =
        fallback === "" ? pane.titleSources : { ...pane.titleSources, fallback };
      const nextPane: PaneState = {
        ...pane,
        sessionId: action.sessionId,
        titleSources,
        title: effectiveTitle(titleSources),
      };
      return replacePane(state, tab, action.paneId, nextPane);
    }

    case "setTitleSource": {
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state;
      const pane = tab.panes[action.paneId];
      if (!pane) return state; // dead/unknown pane — junk-inert, === no-op
      const clean = action.value === null ? "" : sanitizeTitle(action.value);
      const next = clean === "" ? undefined : clean;
      if (pane.titleSources[action.source] === next) return state; // unchanged / already clear
      const titleSources: TitleSources = { ...pane.titleSources };
      if (next === undefined) delete titleSources[action.source];
      else titleSources[action.source] = next;
      const nextPane: PaneState = { ...pane, titleSources, title: effectiveTitle(titleSources) };
      return replacePane(state, tab, action.paneId, nextPane);
    }

    case "closeTab": {
      const idx = state.tabs.findIndex((t) => t.tabId === action.tabId);
      if (idx === -1) return state;
      const tabs = state.tabs.filter((t) => t.tabId !== action.tabId);
      let activeTabId = state.activeTabId;
      if (state.activeTabId === action.tabId) {
        // iTerm2 rule: the RIGHT neighbor now sits at the closed tab's index; fall back to the
        // LEFT one; an emptied strip has nothing to activate.
        const neighbor = tabs[idx] ?? tabs[idx - 1];
        activeTabId = neighbor ? neighbor.tabId : null;
      }
      return { ...state, tabs, activeTabId };
    }

    case "activateTab": {
      if (!state.tabs.some((t) => t.tabId === action.tabId)) return state;
      return withActive(state, action.tabId);
    }

    case "nextTab":
    case "prevTab": {
      const len = state.tabs.length;
      if (len === 0) return state;
      const idx = state.tabs.findIndex((t) => t.tabId === state.activeTabId);
      if (idx === -1) return state; // defensive: unreachable under this reducer's own transitions
      const step = action.kind === "nextTab" ? 1 : -1;
      const target = state.tabs[(idx + step + len) % len].tabId; // wrap around both directions
      return withActive(state, target); // single tab wraps to itself → === no-op
    }

    case "selectIndex": {
      const len = state.tabs.length;
      if (len === 0) return state;
      // ⌘9 (index 8) = the LAST tab (iTerm2), even when more than 9 tabs exist.
      const idx = action.index === 8 ? len - 1 : action.index;
      if (!Number.isInteger(idx) || idx < 0 || idx >= len) return state;
      return withActive(state, state.tabs[idx].tabId);
    }

    case "moveTab": {
      const len = state.tabs.length;
      const { from } = action;
      if (!Number.isInteger(from) || !Number.isInteger(action.to)) return state;
      if (from < 0 || from >= len) return state; // a nonexistent source can't move
      const to = Math.min(Math.max(action.to, 0), len - 1); // clamp the destination into range
      if (from === to) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      // activeTabId is an IDENTITY, not an index — a reorder never changes which tab is active.
      return { ...state, tabs };
    }

    case "splitPane": {
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state;
      const newPaneId = state.nextPaneId;
      const tree = splitLeaf(tab.tree, tab.focusedPaneId, action.dir, newPaneId);
      if (tree === tab.tree) return state; // focused pane isn't a leaf (defensive) — no-op
      const pane = makePane(null, ""); // session-less until App's open_pty resolves
      const nextTab: Tab = {
        ...tab,
        tree,
        panes: { ...tab.panes, [newPaneId]: pane },
        focusedPaneId: newPaneId, // the new pane takes focus (iTerm2)
        title: pane.title,
      };
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.tabId === tab.tabId ? nextTab : t)),
        nextPaneId: state.nextPaneId + 1,
      };
    }

    case "closePane": {
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state;
      if (!tab.panes[action.paneId]) return state; // unknown pane — no-op
      const { tree, focusNext } = removeLeaf(tab.tree, action.paneId);
      // The LAST pane emptied the tree — App owns tab/window close, NOT the reducer, so no-op here.
      if (tree === null || focusNext === null) return state;
      const panes = { ...tab.panes };
      delete panes[action.paneId];
      const focusedPaneId = tab.focusedPaneId === action.paneId ? focusNext : tab.focusedPaneId;
      const nextTab: Tab = { ...tab, tree, panes, focusedPaneId, title: panes[focusedPaneId].title };
      return replaceTab(state, tab.tabId, nextTab);
    }

    case "focusPane": {
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state;
      if (!tab.panes[action.paneId]) return state; // unknown pane — no-op
      if (tab.focusedPaneId === action.paneId) return state; // already focused — === no-op
      const nextTab: Tab = {
        ...tab,
        focusedPaneId: action.paneId,
        title: tab.panes[action.paneId].title, // the tab label follows focus
      };
      return replaceTab(state, tab.tabId, nextTab);
    }

    case "setPaneRatio": {
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state;
      const tree = setRatioTree(tab.tree, action.path, action.ratio);
      if (tree === tab.tree) return state; // no change — === no-op
      return replaceTab(state, tab.tabId, { ...tab, tree });
    }

    case "setBadge": {
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state;
      const pane = tab.panes[action.paneId];
      if (!pane) return state; // dead/unknown pane — no-op (===)
      // A single opaque slot: a string sets it, null clears it (→ undefined). Last-write-wins, no
      // ladder. The badge is NOT a title source, so `nextPane.title === pane.title` and replacePane
      // recomputes the derived tab title to the SAME value — a badge never moves the tab label, on
      // the focused pane or a background one (title-orthogonal by construction).
      const nextPane: PaneState = { ...pane, badge: action.badge ?? undefined };
      return replacePane(state, tab, action.paneId, nextPane);
    }
  }
}

/** The tab + paneId bound to `sessionId`, or undefined (session-less panes never match). */
export function paneBySessionId(
  state: TabsState,
  sessionId: number,
): { tab: Tab; paneId: PaneId } | undefined {
  for (const tab of state.tabs) {
    for (const key of Object.keys(tab.panes)) {
      const paneId = Number(key);
      if (tab.panes[paneId].sessionId === sessionId) return { tab, paneId };
    }
  }
  return undefined;
}

/** The tab owning `sessionId` (any of its panes), or undefined. */
export function tabBySessionId(state: TabsState, sessionId: number): Tab | undefined {
  return paneBySessionId(state, sessionId)?.tab;
}

/** Every paneId of a tab in layout (DFS) order — the ONLY correct pane iteration order. */
export function tabPaneIds(tab: Tab): PaneId[] {
  return leaves(tab.tree);
}

/** Whether the focused pane can split along `dir` within `bounds` without going below `min`. */
export function canSplitFocused(tab: Tab, dir: SplitDir, bounds: Rect, min: MinSize): boolean {
  return canSplitTree(tab.tree, tab.focusedPaneId, dir, bounds, min);
}
