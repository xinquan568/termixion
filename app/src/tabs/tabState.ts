// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-74: the pure tab model — a reducer over TabsState with NO React import, so every transition
// the tab bar needs (open, session attach, close, activate, next/prev wrap, ⌘1..⌘9 selection, drag
// reorder) is unit-testable headless and the React layer stays a thin `useReducer` shell.
//
// Conventions (all iTerm2-modeled):
// - Tab ids are MONOTONIC and never reused — `nextTabId` only increments, so a stale id (a closed
//   tab referenced by an in-flight async open) can never alias a new tab.
// - A tab is born with a session-less pane (`sessionId: null`); the async open_pty resolution
//   attaches the session later. If the tab died in between, `attachSession` is a no-op and the
//   CALLER disposes the orphan session (the reducer never owns backend resources).
// - Closing the ACTIVE tab activates the RIGHT neighbor, else the LEFT one, else nothing.
// - `selectIndex` 8 (⌘9) means the LAST tab regardless of count.
// - Every no-op returns the IDENTICAL state object (===), so a React `useReducer` consumer skips
//   the re-render and tests can pin no-op-ness exactly.
// - trmx-75 (FR-2.4): titles are layered SOURCES (manual > osc > process > fallback, tabTitle.ts).
//   `setTitleSource` sets/clears the three optional slots; `openTab`/`attachSession` seed/refresh
//   the fallback; EVERY sources change recomputes `Tab.title = effectiveTitle(titleSources)`, so
//   `title` stays THE one rendered string the strip/window consume.

import { effectiveTitle, sanitizeTitle, type TitleSources } from "./tabTitle";

/** One tab's terminal pane: the backend session it is bound to, or null while the open is in flight. */
export interface TabPane {
  sessionId: number | null;
}

/** One tab: a stable identity, the rendered title (always `effectiveTitle(titleSources)`), its pane. */
export interface Tab {
  tabId: number;
  title: string;
  titleSources: TitleSources;
  pane: TabPane;
}

/** The whole tab strip: ordered tabs, the active tab's id (null when empty), and the id counter. */
export interface TabsState {
  tabs: Tab[];
  activeTabId: number | null;
  nextTabId: number;
}

/** Every transition the tab strip supports — a discriminated union over `kind`. */
export type TabsAction =
  | { kind: "openTab"; title?: string }
  | { kind: "attachSession"; tabId: number; sessionId: number; title: string }
  // trmx-75: set (string) or clear (null — a value that sanitizes to empty clears too) one of
  // the three overridable title slots. The fallback slot is owned by openTab/attachSession.
  | {
      kind: "setTitleSource";
      tabId: number;
      source: "manual" | "osc" | "process";
      value: string | null;
    }
  | { kind: "closeTab"; tabId: number }
  | { kind: "activateTab"; tabId: number }
  | { kind: "nextTab" }
  | { kind: "prevTab" }
  | { kind: "selectIndex"; index: number }
  | { kind: "moveTab"; from: number; to: number };

/** The empty strip: no tabs, nothing active, ids starting at 1. */
export function initialTabsState(): TabsState {
  return { tabs: [], activeTabId: null, nextTabId: 1 };
}

// Activate `tabId` if it differs from the current active — shared by activate/next/prev/select so
// every "activation didn't change" path is the same `===` no-op.
function withActive(state: TabsState, tabId: number): TabsState {
  return state.activeTabId === tabId ? state : { ...state, activeTabId: tabId };
}

/** Reduce one action. Pure: never mutates `state`; every no-op returns `state` itself (===). */
export function reduceTabs(state: TabsState, action: TabsAction): TabsState {
  switch (action.kind) {
    case "openTab": {
      // trmx-75: the title arg seeds the FALLBACK source, sanitized at the boundary; a junk arg
      // (empty after sanitization) falls back to "Shell" so the last resort is never empty.
      const titleSources: TitleSources = {
        fallback: sanitizeTitle(action.title ?? "") || "Shell",
      };
      const tab: Tab = {
        tabId: state.nextTabId,
        title: effectiveTitle(titleSources),
        titleSources,
        pane: { sessionId: null },
      };
      // Append + activate; the id counter only ever increments (never reused, see header).
      return {
        tabs: [...state.tabs, tab],
        activeTabId: tab.tabId,
        nextTabId: state.nextTabId + 1,
      };
    }

    case "attachSession": {
      // The async open can resolve after the user closed the tab: don't resurrect it — no-op, and
      // the caller (seeing the unchanged state / missing tab) disposes the orphan session.
      if (!state.tabs.some((t) => t.tabId === action.tabId)) return state;
      // trmx-75: the session title refreshes the FALLBACK source only — it must never demote a
      // manual/OSC title that raced ahead of this async resolution. A junk title (empty after
      // sanitization) keeps the previous fallback so the last resort stays non-empty.
      const fallback = sanitizeTitle(action.title);
      return {
        ...state,
        tabs: state.tabs.map((t) => {
          if (t.tabId !== action.tabId) return t;
          const titleSources: TitleSources =
            fallback === "" ? t.titleSources : { ...t.titleSources, fallback };
          return {
            ...t,
            title: effectiveTitle(titleSources),
            titleSources,
            pane: { sessionId: action.sessionId },
          };
        }),
      };
    }

    case "setTitleSource": {
      const tab = state.tabs.find((t) => t.tabId === action.tabId);
      if (!tab) return state; // dead/unknown tab (e.g. a late poller hint) — junk-inert, === no-op
      // Boundary sanitization: slots STORE sanitized values. null or empty-after-sanitize CLEARS
      // the slot — the manual clear-to-auto and empty-OSC-reset rules share this one path.
      const clean = action.value === null ? "" : sanitizeTitle(action.value);
      const next = clean === "" ? undefined : clean;
      if (tab.titleSources[action.source] === next) return state; // unchanged / already clear
      const titleSources: TitleSources = { ...tab.titleSources };
      if (next === undefined) delete titleSources[action.source];
      else titleSources[action.source] = next;
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.tabId === action.tabId
            ? { ...t, title: effectiveTitle(titleSources), titleSources }
            : t,
        ),
      };
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
  }
}

/** The tab bound to `sessionId`, or undefined (session-less panes never match). */
export function tabBySessionId(state: TabsState, sessionId: number): Tab | undefined {
  return state.tabs.find((t) => t.pane.sessionId === sessionId);
}
