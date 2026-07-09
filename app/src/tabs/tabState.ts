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
// `title` is DERIVED — the tab-scoped manual pin (trmx-166, `manualTitle`) when set, else the
// FOCUSED pane's effective title — so the strip/window still consume one string; without a pin it
// switches source as focus moves between panes, and with one it stays put (see `deriveTitle`).
//
// Conventions (all iTerm2-modeled):
// - Tab ids AND pane ids are MONOTONIC and never reused (`nextTabId`/`nextPaneId` only increment),
//   so a stale id can never alias a new tab/pane. Pane ids are GLOBAL across tabs, so the render
//   layer's paneId-keyed maps never collide.
// - A pane is born session-less (`sessionId: null`); the async open_pty resolution attaches the
//   session later via `attachSession`. If the pane/tab died in between, attach is a no-op and the
//   CALLER disposes the orphan session (the reducer never owns backend resources).
// - Closing the ACTIVE tab activates the RIGHT neighbor, else the LEFT one, else nothing.
// - `selectIndex` is strictly positional (trmx-151): index 8 (⌘9) is the NINTH tab, never "the
//   last"; tabs beyond nine are reached via ⌘⇧]/⌘⇧[ or the mouse.
// - Every no-op returns the IDENTICAL state object (===), so a React `useReducer` consumer skips
//   the re-render and tests can pin no-op-ness exactly.
// - trmx-75/166 titles: each PANE has an automatic source ladder (osc > process > fallback,
//   tabTitle.ts); every sources change recomputes that pane's `title`. The user's manual rename is
//   a TAB-scoped pin (`Tab.manualTitle`) — `deriveTitle`/`tabTitle` derive the tab label as the pin
//   when set, else the focused pane's effective title, so a rename survives pane focus/splits and a
//   background pane's title change never moves the label.
// - trmx-90 adds a per-pane `badge`: an ephemeral, session-lifetime overlay label — a SINGLE opaque
//   slot (last-write-wins, NOT a source ladder like the title). It is orthogonal to the title:
//   setting/clearing a badge never moves the tab label, even on the focused pane.
// - Pane ORDER always comes from the layout tree (`leaves`), never `Object.keys(panes)` (numeric
//   object keys enumerate string-coerced in ascending order, which is NOT layout order).

import { effectiveTitle, sanitizeTitle, tabTitle, type TitleSources } from "./tabTitle";
import {
  canSplit as canSplitTree,
  leafNode,
  leaves,
  moveLeaf,
  removeLeaf,
  setRatio as setRatioTree,
  splitLeaf,
  swapLeaves,
  type DropEdge,
  type LayoutNode,
  type MinSize,
  type PaneId,
  type Rect,
  type SplitDir,
  type SplitPath,
} from "../panes/layoutTree";
import { movePaneDirectional, type Direction } from "../panes/paneNav";

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
  /**
   * trmx-91: whether the pane's activity line is on-screen right now (undefined = off). App owns the
   * debounce (panes/activityLine.ts) and dispatches only the resolved on/off; like `badge` it is a
   * single ephemeral slot orthogonal to the title, so toggling it never moves the derived tab label.
   */
  activityVisible?: boolean;
}

/** One tab: a stable identity, the pure pane tree, the focused pane, per-pane state, derived title. */
export interface Tab {
  tabId: number;
  tree: LayoutNode;
  focusedPaneId: PaneId;
  panes: Record<PaneId, PaneState>;
  /**
   * trmx-166: the user's tab-level manual title (the rename PIN) — `undefined` (or empty after
   * sanitize) means "follow focus". When set, it overrides the focused pane's effective title for
   * the derived `title`, so the tab label stays put across pane splits and focus changes. It is a
   * TAB label only: per-pane `PaneState.title` (and the core session mirror) are unaffected.
   */
  manualTitle?: string;
  /**
   * Derived: `tabTitle(manualTitle, focusedPane.titleSources)` — the manual pin when set, else the
   * FOCUSED pane's effective title. The ONE string the strip/window consume; recomputed via
   * `deriveTitle` at every write site.
   */
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
  // trmx-75/84: set (string) or clear (null) one of a PANE's AUTOMATIC title slots. trmx-166: the
  // user's `manual` rename left this ladder — it is now the tab-scoped `setTabTitle` below.
  | {
      kind: "setTitleSource";
      tabId: number;
      paneId: number;
      source: "osc" | "process";
      value: string | null;
    }
  // trmx-166: set (string) or clear (null/empty) a TAB's manual title pin — overrides the focused
  // pane's effective title for the tab label until cleared back to auto.
  | { kind: "setTabTitle"; tabId: number; value: string | null }
  | { kind: "closeTab"; tabId: number }
  | { kind: "activateTab"; tabId: number }
  | { kind: "nextTab" }
  | { kind: "prevTab" }
  | { kind: "selectIndex"; index: number }
  | { kind: "moveTab"; from: number; to: number }
  // trmx-84 (FR-3.1/3.2): pane transitions.
  | { kind: "splitPane"; tabId: number; dir: SplitDir }
  // trmx-100 (FR-3.4): mouse re-dock — move `paneId` onto `targetPaneId`'s zone (edge = new split, center
  // = swap). App only dispatches for a non-null actionable target. Keyboard: `movePaneDir` (directional).
  | {
      kind: "redockPane";
      tabId: number;
      paneId: number;
      targetPaneId: number;
      zone: DropEdge | "center";
    }
  | { kind: "movePaneDir"; tabId: number; paneId: number; dir: Direction; bounds: Rect }
  | { kind: "closePane"; tabId: number; paneId: number }
  | { kind: "focusPane"; tabId: number; paneId: number }
  | { kind: "setPaneRatio"; tabId: number; path: SplitPath; ratio: number }
  // trmx-90: set (string) or clear (null) a PANE's ephemeral badge — last-write-wins, title-independent.
  | { kind: "setBadge"; tabId: number; paneId: number; badge: string | null }
  // trmx-91: set the PANE's activity-line visibility — App-driven (the debounce owns the timing).
  | { kind: "setActivity"; tabId: number; paneId: number; visible: boolean };

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

// trmx-166: the derived tab label — the manual pin (`Tab.manualTitle`) when set, else the FOCUSED
// pane's effective title. EVERY tab-title write routes through here, so the pin is honored at all of
// them (split, focus, close, redock, move, attach) and no site can silently drop it; a background
// pane's automatic title change still never moves the label (this reads only the focused pane).
function deriveTitle(
  manualTitle: string | undefined,
  panes: Record<PaneId, PaneState>,
  focusedPaneId: PaneId,
): string {
  return tabTitle(manualTitle, panes[focusedPaneId].titleSources);
}

// Swap paneId's PaneState in `tab`, recomputing the tab's DERIVED title. With no manual pin a
// background pane's title update leaves the label unchanged (deriveTitle reads only the focused
// pane); with a pin the label stays the pinned title regardless (background isolation preserved).
function replacePane(state: TabsState, tab: Tab, paneId: PaneId, nextPane: PaneState): TabsState {
  const panes = { ...tab.panes, [paneId]: nextPane };
  const title = deriveTitle(tab.manualTitle, panes, tab.focusedPaneId);
  return replaceTab(state, tab.tabId, { ...tab, panes, title });
}

/** Reduce one action. Pure: never mutates `state`; every no-op returns `state` itself (===). */
export function reduceTabs(state: TabsState, action: TabsAction): TabsState {
  switch (action.kind) {
    case "openTab": {
      const paneId = state.nextPaneId;
      const pane = makePane(null, action.title ?? "");
      const panes = { [paneId]: pane };
      const tab: Tab = {
        tabId: state.nextTabId,
        tree: leafNode(paneId),
        focusedPaneId: paneId,
        panes,
        // trmx-166: route through deriveTitle like every other write site (a fresh tab has no pin,
        // so this equals pane.title — but the invariant "all tab-title writes go through deriveTitle"
        // holds uniformly).
        title: deriveTitle(undefined, panes, paneId),
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

    case "setTabTitle": {
      // trmx-166: set/clear the tab-scoped manual pin. Empty-after-sanitize (or null) clears it back
      // to "follow focus"; the derived title recomputes to the pin (if set) or the focused pane's
      // effective title. A no-op change returns the identical state object (=== ) like every other
      // transition. The per-pane titleSources and the core session mirror are untouched.
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state;
      const clean = action.value === null ? "" : sanitizeTitle(action.value);
      const manualTitle = clean === "" ? undefined : clean;
      if (tab.manualTitle === manualTitle) return state; // unchanged / already clear — === no-op
      const title = deriveTitle(manualTitle, tab.panes, tab.focusedPaneId);
      return replaceTab(state, tab.tabId, { ...tab, manualTitle, title });
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
      // trmx-151 product decision: the numbering feature is STRICTLY first-nine — index 8 (⌘9)
      // selects the NINTH tab, period (the old iTerm2 "8 → last" mapping is gone). Tabs beyond 9
      // are reachable via ⌘⇧]/⌘⇧[ or the mouse; out-of-range indexes stay range-guarded no-ops.
      const idx = action.index;
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
      const panes = { ...tab.panes, [newPaneId]: pane };
      const nextTab: Tab = {
        ...tab,
        tree,
        panes,
        focusedPaneId: newPaneId, // the new pane takes focus (iTerm2)
        // trmx-166: a manual pin survives the split — deriveTitle returns the pin if set, else the
        // new focused pane's title.
        title: deriveTitle(tab.manualTitle, panes, newPaneId),
      };
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.tabId === tab.tabId ? nextTab : t)),
        nextPaneId: state.nextPaneId + 1,
      };
    }

    case "redockPane": {
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state;
      if (!tab.panes[action.paneId] || !tab.panes[action.targetPaneId]) return state; // unknown — no-op
      const tree =
        action.zone === "center"
          ? swapLeaves(tab.tree, action.paneId, action.targetPaneId)
          : moveLeaf(tab.tree, action.paneId, action.targetPaneId, action.zone);
      if (tree === tab.tree) return state; // === no-op (self/degenerate/structurally identical)
      // The moved pane keeps focus (so chained moves feel natural + the survival invariant holds).
      const nextTab: Tab = {
        ...tab,
        tree,
        focusedPaneId: action.paneId,
        title: deriveTitle(tab.manualTitle, tab.panes, action.paneId), // trmx-166: pin survives
      };
      return replaceTab(state, tab.tabId, nextTab);
    }

    case "movePaneDir": {
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state;
      if (!tab.panes[action.paneId]) return state; // unknown pane — no-op
      const tree = movePaneDirectional(tab.tree, action.paneId, action.dir, action.bounds);
      if (tree === tab.tree) return state; // no neighbor / structural no-op — === no-op
      const nextTab: Tab = {
        ...tab,
        tree,
        focusedPaneId: action.paneId, // the moved pane stays focused (keyboard moves chain)
        title: deriveTitle(tab.manualTitle, tab.panes, action.paneId), // trmx-166: pin survives
      };
      return replaceTab(state, tab.tabId, nextTab);
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
      // trmx-166: closing a pane (incl. the one focused at rename time) keeps the manual pin.
      const nextTab: Tab = {
        ...tab,
        tree,
        panes,
        focusedPaneId,
        title: deriveTitle(tab.manualTitle, panes, focusedPaneId),
      };
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
        // trmx-166: with no manual pin the label follows focus; a pin overrides it (stays put).
        title: deriveTitle(tab.manualTitle, tab.panes, action.paneId),
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

    case "setActivity": {
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state;
      const pane = tab.panes[action.paneId];
      if (!pane) return state; // dead/unknown pane — no-op (===)
      // A single ephemeral slot (the badge idiom): visible → true, not-visible → undefined. An
      // unchanged value is an === no-op so a redundant App dispatch skips the re-render. Like the
      // badge it is NOT a title source, so replacePane recomputes the derived tab title to the SAME
      // value — the activity line never moves the tab label, on the focused pane or a background one.
      const activityVisible = action.visible ? true : undefined;
      if (pane.activityVisible === activityVisible) return state; // unchanged — === no-op
      const nextPane: PaneState = { ...pane, activityVisible };
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
