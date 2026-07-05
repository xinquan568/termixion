// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-74/75/84 (test-first): the pure tab+pane reducer. Every transition — open, per-pane attach,
// close (iTerm2 right-then-left activation), activate, wrap next/prev, ⌘1..⌘9 selectIndex (index 8
// = LAST), drag reorder, AND the trmx-84 pane transitions (split/close/focus/ratio) — is pinned
// here headless: no React, no DOM, state in / state out. No-op transitions return the IDENTICAL
// state object (===). Titles are per-PANE layered sources; the tab's rendered title is the FOCUSED
// pane's effective title (a background pane's title change never moves the tab label).
import { describe, it, expect } from "vitest";
import {
  canSplitFocused,
  initialTabsState,
  paneBySessionId,
  reduceTabs,
  tabBySessionId,
  tabPaneIds,
  type Tab,
  type TabsAction,
  type TabsState,
} from "./tabState";
import { leaves } from "../panes/layoutTree";

/** Reduce a fresh initial state through `actions` in order. */
function run(...actions: TabsAction[]): TabsState {
  return actions.reduce(reduceTabs, initialTabsState());
}

/** A state with `n` open tabs (tabIds 1..n, paneIds 1..n, the last one active). */
function withTabs(n: number): TabsState {
  return run(...Array.from({ length: n }, (): TabsAction => ({ kind: "openTab" })));
}

const tabIds = (state: TabsState) => state.tabs.map((t) => t.tabId);
const focusedPane = (tab: Tab) => tab.panes[tab.focusedPaneId];

// Freeze the state tree so any in-place mutation inside the reducer throws (purity guard).
function deepFreeze(state: TabsState): TabsState {
  state.tabs.forEach((t) => {
    Object.values(t.panes).forEach((p) => {
      Object.freeze(p.titleSources);
      Object.freeze(p);
    });
    Object.freeze(t.panes);
    Object.freeze(t.tree);
    Object.freeze(t);
  });
  Object.freeze(state.tabs);
  return Object.freeze(state);
}

describe("initialTabsState", () => {
  it("starts empty: no tabs, no active tab, tab AND pane ids from 1", () => {
    expect(initialTabsState()).toEqual({
      tabs: [],
      activeTabId: null,
      nextTabId: 1,
      nextPaneId: 1,
    });
  });
});

describe("openTab", () => {
  it("appends a single-leaf tab: one session-less focused pane, default title, activated", () => {
    const state = run({ kind: "openTab" });
    expect(state.tabs).toHaveLength(1);
    const tab = state.tabs[0];
    expect(tab.tabId).toBe(1);
    expect(tab.tree).toEqual({ kind: "leaf", paneId: 1 });
    expect(tab.focusedPaneId).toBe(1);
    expect(tab.panes).toEqual({
      1: { sessionId: null, titleSources: { fallback: "Shell" }, title: "Shell" },
    });
    expect(tab.title).toBe("Shell");
    expect(state.activeTabId).toBe(1);
    expect(state.nextTabId).toBe(2);
    expect(state.nextPaneId).toBe(2);
  });

  it("honors an explicit title (seeded as the focused pane's FALLBACK source)", () => {
    const tab = run({ kind: "openTab", title: "build" }).tabs[0];
    expect(tab.title).toBe("build");
    expect(focusedPane(tab).titleSources).toEqual({ fallback: "build" });
  });

  it("sanitizes the title arg; a junk arg seeds the default fallback", () => {
    expect(run({ kind: "openTab", title: "  build " }).tabs[0].title).toBe("build");
    const junk = run({ kind: "openTab", title: " \u{7} " }).tabs[0];
    expect(junk.title).toBe("Shell");
    expect(focusedPane(junk).titleSources).toEqual({ fallback: "Shell" });
  });

  it("appends at the end, moves activation, and advances both id counters", () => {
    const state = run({ kind: "openTab" }, { kind: "openTab" }, { kind: "openTab" });
    expect(tabIds(state)).toEqual([1, 2, 3]);
    expect(state.activeTabId).toBe(3);
    expect(state.nextTabId).toBe(4);
    expect(state.nextPaneId).toBe(4); // one pane per fresh tab
    // Each tab has a distinct pane id.
    expect(state.tabs.map((t) => t.focusedPaneId)).toEqual([1, 2, 3]);
  });

  it("does not mutate the input state", () => {
    const before = deepFreeze(withTabs(2));
    expect(() => reduceTabs(before, { kind: "openTab" })).not.toThrow();
    expect(before.tabs).toHaveLength(2);
  });
});

describe("attachSession (per pane)", () => {
  it("binds the sessionId and title to the addressed pane", () => {
    const state = run(
      { kind: "openTab" },
      { kind: "openTab" },
      { kind: "attachSession", tabId: 1, paneId: 1, sessionId: 77, title: "zsh" },
    );
    expect(state.tabs[0].panes[1]).toEqual({
      sessionId: 77,
      titleSources: { fallback: "zsh" },
      title: "zsh",
    });
    expect(state.tabs[0].title).toBe("zsh"); // pane 1 is focused → tab label follows
    // The sibling tab is untouched.
    expect(state.tabs[1].panes[2].sessionId).toBeNull();
    expect(state.tabs[1].title).toBe("Shell");
  });

  it("updates the fallback WITHOUT demoting a present OSC title", () => {
    let s = run({ kind: "openTab" });
    s = reduceTabs(s, { kind: "setTitleSource", tabId: 1, paneId: 1, source: "osc", value: "vim" });
    expect(s.tabs[0].title).toBe("vim");
    s = reduceTabs(s, { kind: "attachSession", tabId: 1, paneId: 1, sessionId: 7, title: "zsh" });
    expect(s.tabs[0].title).toBe("vim"); // still the OSC title
    expect(s.tabs[0].panes[1].sessionId).toBe(7); // but the attach landed
    s = reduceTabs(s, { kind: "setTitleSource", tabId: 1, paneId: 1, source: "osc", value: null });
    expect(s.tabs[0].title).toBe("zsh"); // refreshed fallback revealed
  });

  it("keeps the previous fallback when the attach title sanitizes to empty (junk-inert)", () => {
    const s = run(
      { kind: "openTab" },
      { kind: "attachSession", tabId: 1, paneId: 1, sessionId: 7, title: " \u{1b} " },
    );
    expect(s.tabs[0].title).toBe("Shell");
    expect(s.tabs[0].panes[1].sessionId).toBe(7);
  });

  it("is a no-op (===) on a dead tab, an unknown pane, and the empty state", () => {
    const dead = run({ kind: "openTab" }, { kind: "openTab" }, { kind: "closeTab", tabId: 1 });
    expect(
      reduceTabs(dead, { kind: "attachSession", tabId: 1, paneId: 1, sessionId: 9, title: "x" }),
    ).toBe(dead);
    const one = run({ kind: "openTab" });
    expect(
      reduceTabs(one, { kind: "attachSession", tabId: 1, paneId: 99, sessionId: 9, title: "x" }),
    ).toBe(one); // unknown pane
    const empty = initialTabsState();
    expect(
      reduceTabs(empty, { kind: "attachSession", tabId: 1, paneId: 1, sessionId: 1, title: "x" }),
    ).toBe(empty);
  });
});

// trmx-75 title precedence, now at PANE scope — the single-pane case is the regression that a tab
// behaves exactly as before this feature.
describe("setTitleSource — single-pane regression (trmx-75 precedence intact)", () => {
  function attached(): TabsState {
    return run(
      { kind: "openTab" },
      { kind: "attachSession", tabId: 1, paneId: 1, sessionId: 7, title: "zsh" },
    );
  }
  function set(
    state: TabsState,
    source: "manual" | "osc" | "process",
    value: string | null,
  ): TabsState {
    return reduceTabs(state, { kind: "setTitleSource", tabId: 1, paneId: 1, source, value });
  }
  const title = (state: TabsState) => state.tabs[0].title;

  it("renders the precedence chain: fallback < process < osc, osc stays over later hints", () => {
    let s = attached();
    expect(title(s)).toBe("zsh");
    s = set(s, "process", "sleep");
    expect(title(s)).toBe("sleep");
    s = set(s, "osc", "vim");
    expect(title(s)).toBe("vim");
    s = set(s, "process", "node");
    expect(title(s)).toBe("vim");
  });

  it("manual overrides everything and a process hint can never clobber manual/osc", () => {
    let s = attached();
    s = set(s, "osc", "vim");
    s = set(s, "manual", "work");
    expect(title(s)).toBe("work");
    s = set(s, "osc", "emacs");
    expect(title(s)).toBe("work");
    s = set(s, "process", "sleep");
    expect(title(s)).toBe("work");
  });

  it("clearing cascades manual → osc → process → fallback", () => {
    let s = attached();
    s = set(s, "process", "sleep");
    s = set(s, "osc", "vim");
    s = set(s, "manual", "work");
    s = set(s, "manual", null);
    expect(title(s)).toBe("vim");
    s = set(s, "osc", null);
    expect(title(s)).toBe("sleep");
    s = set(s, "process", null);
    expect(title(s)).toBe("zsh");
  });

  it("re-delivering the same value or clearing an absent slot is a no-op (===)", () => {
    const s = set(attached(), "process", "sleep");
    expect(set(s, "process", "sleep")).toBe(s);
    expect(set(s, "process", " sleep \u{7}")).toBe(s);
    expect(set(s, "manual", null)).toBe(s);
  });

  it("is a no-op (===) on a dead tab, an unknown pane, and the empty state", () => {
    const dead = run({ kind: "openTab" }, { kind: "openTab" }, { kind: "closeTab", tabId: 1 });
    expect(
      reduceTabs(dead, { kind: "setTitleSource", tabId: 1, paneId: 1, source: "manual", value: "x" }),
    ).toBe(dead);
    const one = run({ kind: "openTab" });
    expect(
      reduceTabs(one, { kind: "setTitleSource", tabId: 1, paneId: 99, source: "osc", value: "x" }),
    ).toBe(one);
  });

  it("does not mutate the input state (purity guard)", () => {
    const before = deepFreeze(set(attached(), "osc", "vim"));
    expect(() => set(before, "manual", "work")).not.toThrow();
    expect(title(before)).toBe("vim");
  });
});

describe("splitPane (trmx-84 FR-3.1/3.2)", () => {
  it("splits the focused pane 50/50, allocates a monotonic pane id, focuses the NEW pane", () => {
    const s = run({ kind: "openTab" }, { kind: "splitPane", tabId: 1, dir: "row" });
    const tab = s.tabs[0];
    expect(tab.tree).toEqual({
      kind: "split",
      dir: "row",
      ratio: 0.5,
      first: { kind: "leaf", paneId: 1 },
      second: { kind: "leaf", paneId: 2 },
    });
    expect(tab.focusedPaneId).toBe(2); // the new pane takes focus
    expect(Object.keys(tab.panes).map(Number).sort()).toEqual([1, 2]);
    expect(tab.panes[2]).toEqual({
      sessionId: null,
      titleSources: { fallback: "Shell" },
      title: "Shell",
    });
    expect(s.nextPaneId).toBe(3);
  });

  it("honors dir: column splits below", () => {
    const s = run({ kind: "openTab" }, { kind: "splitPane", tabId: 1, dir: "column" });
    expect((s.tabs[0].tree as { dir: string }).dir).toBe("column");
  });

  it("splitting again splits the NEW focused pane (nesting), preserving other panes' identity", () => {
    let s = run({ kind: "openTab" }, { kind: "splitPane", tabId: 1, dir: "row" }); // panes 1|2, focus 2
    const pane1Before = s.tabs[0].panes[1];
    s = reduceTabs(s, { kind: "splitPane", tabId: 1, dir: "column" }); // splits 2 → (2/3)
    expect(leaves(s.tabs[0].tree)).toEqual([1, 2, 3]);
    expect(s.tabs[0].focusedPaneId).toBe(3);
    expect(s.tabs[0].panes[1]).toBe(pane1Before); // untouched pane keeps identity
  });

  it("is a no-op (===) on an unknown tab", () => {
    const s = run({ kind: "openTab" });
    expect(reduceTabs(s, { kind: "splitPane", tabId: 99, dir: "row" })).toBe(s);
  });

  it("does not mutate the input state", () => {
    const before = deepFreeze(run({ kind: "openTab" }));
    expect(() => reduceTabs(before, { kind: "splitPane", tabId: 1, dir: "row" })).not.toThrow();
    expect(leaves(before.tabs[0].tree)).toEqual([1]);
  });
});

describe("closePane (trmx-84)", () => {
  /** One tab with panes 1 | 2 (focus 2). */
  function split(): TabsState {
    return run({ kind: "openTab" }, { kind: "splitPane", tabId: 1, dir: "row" });
  }

  it("removes a pane, promotes the sibling, and focuses the neighbor", () => {
    const s = reduceTabs(split(), { kind: "closePane", tabId: 1, paneId: 2 });
    const tab = s.tabs[0];
    expect(tab.tree).toEqual({ kind: "leaf", paneId: 1 });
    expect(tab.focusedPaneId).toBe(1);
    expect(Object.keys(tab.panes).map(Number)).toEqual([1]);
    expect(tab.title).toBe(tab.panes[1].title);
  });

  it("closing a NON-focused pane keeps the current focus", () => {
    // panes 1 | 2 focus 2; refocus 1, then close 2 → focus stays 1
    let s = reduceTabs(split(), { kind: "focusPane", tabId: 1, paneId: 1 });
    s = reduceTabs(s, { kind: "closePane", tabId: 1, paneId: 2 });
    expect(s.tabs[0].focusedPaneId).toBe(1);
  });

  it("closing the LAST pane is a no-op (===) — App owns tab close, not the reducer", () => {
    const one = run({ kind: "openTab" });
    expect(reduceTabs(one, { kind: "closePane", tabId: 1, paneId: 1 })).toBe(one);
  });

  it("is a no-op (===) for an unknown pane or tab", () => {
    const s = split();
    expect(reduceTabs(s, { kind: "closePane", tabId: 1, paneId: 99 })).toBe(s);
    expect(reduceTabs(s, { kind: "closePane", tabId: 99, paneId: 2 })).toBe(s);
  });

  it("never reuses a closed pane's id", () => {
    let s = split(); // panes 1|2, nextPaneId 3
    s = reduceTabs(s, { kind: "closePane", tabId: 1, paneId: 2 });
    s = reduceTabs(s, { kind: "splitPane", tabId: 1, dir: "row" }); // new pane must be 3, not 2
    expect(leaves(s.tabs[0].tree)).toEqual([1, 3]);
    expect(s.nextPaneId).toBe(4);
  });
});

describe("focusPane (trmx-84)", () => {
  function split(): TabsState {
    return run({ kind: "openTab" }, { kind: "splitPane", tabId: 1, dir: "row" });
  }

  it("switches the focused pane and the derived tab title follows", () => {
    // give the two panes distinct titles
    let s = split();
    s = reduceTabs(s, { kind: "setTitleSource", tabId: 1, paneId: 1, source: "osc", value: "vim" });
    s = reduceTabs(s, { kind: "setTitleSource", tabId: 1, paneId: 2, source: "osc", value: "top" });
    expect(s.tabs[0].focusedPaneId).toBe(2);
    expect(s.tabs[0].title).toBe("top");
    s = reduceTabs(s, { kind: "focusPane", tabId: 1, paneId: 1 });
    expect(s.tabs[0].focusedPaneId).toBe(1);
    expect(s.tabs[0].title).toBe("vim"); // label switched source with focus
  });

  it("a background pane's title change never moves the tab label (isolation)", () => {
    let s = split(); // focus 2
    // pane 1 is in the background; its OSC title update must not touch the tab label
    s = reduceTabs(s, { kind: "setTitleSource", tabId: 1, paneId: 1, source: "osc", value: "vim" });
    expect(s.tabs[0].focusedPaneId).toBe(2);
    expect(s.tabs[0].title).toBe("Shell"); // still the focused (pane 2) title
    expect(s.tabs[0].panes[1].title).toBe("vim"); // but pane 1 recorded it
  });

  it("is a no-op (===) for the already-focused pane, an unknown pane, and an unknown tab", () => {
    const s = split();
    expect(reduceTabs(s, { kind: "focusPane", tabId: 1, paneId: 2 })).toBe(s); // already focused
    expect(reduceTabs(s, { kind: "focusPane", tabId: 1, paneId: 99 })).toBe(s);
    expect(reduceTabs(s, { kind: "focusPane", tabId: 99, paneId: 2 })).toBe(s);
  });
});

describe("setPaneRatio (trmx-84 — FR-3.3 seam)", () => {
  it("sets the ratio of the split at a path (clamped)", () => {
    let s = run({ kind: "openTab" }, { kind: "splitPane", tabId: 1, dir: "row" });
    s = reduceTabs(s, { kind: "setPaneRatio", tabId: 1, path: [], ratio: 0.7 });
    expect((s.tabs[0].tree as { ratio: number }).ratio).toBeCloseTo(0.7);
  });

  it("is a no-op (===) when the ratio is unchanged or the path is invalid or the tab unknown", () => {
    const s = run({ kind: "openTab" }, { kind: "splitPane", tabId: 1, dir: "row" });
    expect(reduceTabs(s, { kind: "setPaneRatio", tabId: 1, path: [], ratio: 0.5 })).toBe(s);
    expect(reduceTabs(s, { kind: "setPaneRatio", tabId: 1, path: ["first"], ratio: 0.3 })).toBe(s);
    expect(reduceTabs(s, { kind: "setPaneRatio", tabId: 99, path: [], ratio: 0.3 })).toBe(s);
  });
});

// trmx-90: the per-pane badge — an ephemeral, session-lifetime overlay label held on PaneState as a
// single opaque slot (last-write-wins, NOT a title-style source ladder). It is orthogonal to the
// title: a badge set/clear never moves the derived tab label, even on the focused pane.
describe("setBadge (trmx-90 — per-pane badge state)", () => {
  /** One tab with panes 1 | 2 (focus 2). */
  function split(): TabsState {
    return run({ kind: "openTab" }, { kind: "splitPane", tabId: 1, dir: "row" });
  }

  it("sets the focused pane's badge; a second set overwrites (last-write-wins); null clears it", () => {
    let s = run({ kind: "openTab" });
    expect(s.tabs[0].panes[1].badge).toBeUndefined(); // a fresh pane has no badge
    s = reduceTabs(s, { kind: "setBadge", tabId: 1, paneId: 1, badge: "prod" });
    expect(s.tabs[0].panes[1].badge).toBe("prod");
    s = reduceTabs(s, { kind: "setBadge", tabId: 1, paneId: 1, badge: "staging" });
    expect(s.tabs[0].panes[1].badge).toBe("staging"); // overwrites — last write wins, no ladder
    s = reduceTabs(s, { kind: "setBadge", tabId: 1, paneId: 1, badge: null });
    expect(s.tabs[0].panes[1].badge).toBeUndefined(); // null clears back to undefined
  });

  it("never moves the derived tab title (badge is orthogonal to the title)", () => {
    let s = run(
      { kind: "openTab" },
      { kind: "attachSession", tabId: 1, paneId: 1, sessionId: 7, title: "zsh" },
    );
    expect(s.tabs[0].title).toBe("zsh");
    s = reduceTabs(s, { kind: "setBadge", tabId: 1, paneId: 1, badge: "prod" });
    expect(s.tabs[0].title).toBe("zsh"); // the tab label is untouched (badge ≠ title source)
    expect(s.tabs[0].panes[1].title).toBe("zsh"); // nor is the pane's own title
    expect(s.tabs[0].panes[1].badge).toBe("prod");
  });

  it("badges a BACKGROUND pane only — not the focused pane's badge, and no pane's title", () => {
    // panes 1 | 2, focus 2; give each a distinct title so any leak into the tab label is visible
    let s = split();
    s = reduceTabs(s, { kind: "setTitleSource", tabId: 1, paneId: 1, source: "osc", value: "vim" });
    s = reduceTabs(s, { kind: "setTitleSource", tabId: 1, paneId: 2, source: "osc", value: "top" });
    // badge the BACKGROUND pane 1
    s = reduceTabs(s, { kind: "setBadge", tabId: 1, paneId: 1, badge: "bg" });
    expect(s.tabs[0].panes[1].badge).toBe("bg"); // the background pane carries the badge
    expect(s.tabs[0].panes[2].badge).toBeUndefined(); // the focused pane's badge is untouched
    // every title is intact — the background badge scopes to its pane only
    expect(s.tabs[0].focusedPaneId).toBe(2);
    expect(s.tabs[0].title).toBe("top"); // tab label = focused pane's title, unmoved
    expect(s.tabs[0].panes[1].title).toBe("vim");
    expect(s.tabs[0].panes[2].title).toBe("top");
  });

  it("survives an unrelated action — orthogonal to title-source and focus changes", () => {
    let s = split(); // panes 1 | 2, focus 2
    s = reduceTabs(s, { kind: "setBadge", tabId: 1, paneId: 2, badge: "prod" });
    // a title-source change on the SAME pane leaves the badge intact
    s = reduceTabs(s, { kind: "setTitleSource", tabId: 1, paneId: 2, source: "osc", value: "top" });
    expect(s.tabs[0].panes[2].badge).toBe("prod");
    expect(s.tabs[0].panes[2].title).toBe("top");
    // moving focus away and back leaves it intact too
    s = reduceTabs(s, { kind: "focusPane", tabId: 1, paneId: 1 });
    expect(s.tabs[0].panes[2].badge).toBe("prod");
    s = reduceTabs(s, { kind: "focusPane", tabId: 1, paneId: 2 });
    expect(s.tabs[0].panes[2].badge).toBe("prod");
  });

  it("closing the pane drops its badge with the pane", () => {
    let s = split(); // panes 1 | 2, focus 2
    s = reduceTabs(s, { kind: "setBadge", tabId: 1, paneId: 2, badge: "prod" });
    s = reduceTabs(s, { kind: "closePane", tabId: 1, paneId: 2 });
    expect(Object.keys(s.tabs[0].panes).map(Number)).toEqual([1]); // pane 2 removed
    expect(s.tabs[0].panes[2]).toBeUndefined(); // badge gone with the pane
  });

  it("is a no-op (===) for an unknown tab or pane", () => {
    const s = reduceTabs(run({ kind: "openTab" }), {
      kind: "setBadge",
      tabId: 1,
      paneId: 1,
      badge: "x",
    });
    expect(reduceTabs(s, { kind: "setBadge", tabId: 99, paneId: 1, badge: "y" })).toBe(s); // unknown tab
    expect(reduceTabs(s, { kind: "setBadge", tabId: 1, paneId: 99, badge: "y" })).toBe(s); // unknown pane
  });

  it("does not mutate the input state (purity guard)", () => {
    const before = deepFreeze(
      reduceTabs(run({ kind: "openTab" }), { kind: "setBadge", tabId: 1, paneId: 1, badge: "prod" }),
    );
    expect(() =>
      reduceTabs(before, { kind: "setBadge", tabId: 1, paneId: 1, badge: "staging" }),
    ).not.toThrow();
    expect(before.tabs[0].panes[1].badge).toBe("prod");
  });
});

describe("closeTab (whole tab, unchanged tab-order semantics)", () => {
  it("closing the active tab activates its RIGHT neighbor (iTerm2)", () => {
    const state = reduceTabs(withTabs(3), { kind: "activateTab", tabId: 2 });
    const next = reduceTabs(state, { kind: "closeTab", tabId: 2 });
    expect(tabIds(next)).toEqual([1, 3]);
    expect(next.activeTabId).toBe(3);
  });

  it("closing the active LAST tab falls back to the LEFT neighbor", () => {
    const next = reduceTabs(withTabs(3), { kind: "closeTab", tabId: 3 });
    expect(tabIds(next)).toEqual([1, 2]);
    expect(next.activeTabId).toBe(2);
  });

  it("closing the only tab leaves the empty state", () => {
    const next = reduceTabs(withTabs(1), { kind: "closeTab", tabId: 1 });
    expect(next.tabs).toEqual([]);
    expect(next.activeTabId).toBeNull();
  });

  it("is a no-op (===) for an unknown tabId and on the empty state", () => {
    const state = withTabs(2);
    expect(reduceTabs(state, { kind: "closeTab", tabId: 99 })).toBe(state);
    const empty = initialTabsState();
    expect(reduceTabs(empty, { kind: "closeTab", tabId: 1 })).toBe(empty);
  });

  it("never reuses a closed tab's id", () => {
    const state = run(
      { kind: "openTab" },
      { kind: "openTab" },
      { kind: "closeTab", tabId: 2 },
      { kind: "closeTab", tabId: 1 },
      { kind: "openTab" },
    );
    expect(tabIds(state)).toEqual([3]);
    expect(state.nextTabId).toBe(4);
  });
});

describe("activate / next / prev / selectIndex / moveTab (unchanged)", () => {
  it("activateTab activates an existing tab; no-op on absent/already-active/empty", () => {
    const state = withTabs(3);
    expect(reduceTabs(state, { kind: "activateTab", tabId: 1 }).activeTabId).toBe(1);
    expect(reduceTabs(state, { kind: "activateTab", tabId: 99 })).toBe(state);
    expect(reduceTabs(state, { kind: "activateTab", tabId: 3 })).toBe(state);
  });

  it("nextTab / prevTab wrap; no-op on empty and single tab", () => {
    const state = reduceTabs(withTabs(3), { kind: "activateTab", tabId: 1 });
    expect(reduceTabs(state, { kind: "nextTab" }).activeTabId).toBe(2);
    expect(reduceTabs(withTabs(3), { kind: "nextTab" }).activeTabId).toBe(1); // 3 wraps to 1
    expect(reduceTabs(state, { kind: "prevTab" }).activeTabId).toBe(3); // 1 wraps to 3
    const one = withTabs(1);
    expect(reduceTabs(one, { kind: "nextTab" })).toBe(one);
  });

  it("selectIndex activates 0-based; ⌘9 (index 8) = last; out-of-range no-op", () => {
    const state = withTabs(3);
    expect(reduceTabs(state, { kind: "selectIndex", index: 0 }).activeTabId).toBe(1);
    expect(
      reduceTabs(reduceTabs(state, { kind: "activateTab", tabId: 1 }), {
        kind: "selectIndex",
        index: 8,
      }).activeTabId,
    ).toBe(3);
    expect(reduceTabs(state, { kind: "selectIndex", index: 5 })).toBe(state);
  });

  it("moveTab reorders (splice); active identity survives; clamps; no-ops", () => {
    const state = withTabs(3);
    expect(tabIds(reduceTabs(state, { kind: "moveTab", from: 0, to: 2 }))).toEqual([2, 3, 1]);
    const active1 = reduceTabs(state, { kind: "activateTab", tabId: 1 });
    expect(reduceTabs(active1, { kind: "moveTab", from: 0, to: 2 }).activeTabId).toBe(1);
    expect(reduceTabs(state, { kind: "moveTab", from: 1, to: 1 })).toBe(state);
    expect(reduceTabs(state, { kind: "moveTab", from: 3, to: 0 })).toBe(state);
  });
});

describe("paneBySessionId / tabBySessionId / tabPaneIds / canSplitFocused", () => {
  it("paneBySessionId finds the tab + paneId bound to a session", () => {
    const s = run(
      { kind: "openTab" },
      { kind: "openTab" },
      { kind: "splitPane", tabId: 2, dir: "row" }, // tab 2 gets pane 3
      { kind: "attachSession", tabId: 2, paneId: 3, sessionId: 77, title: "zsh" },
    );
    const hit = paneBySessionId(s, 77);
    expect(hit?.tab.tabId).toBe(2);
    expect(hit?.paneId).toBe(3);
    expect(tabBySessionId(s, 77)?.tabId).toBe(2);
  });

  it("returns undefined for an unknown session and never matches session-less panes", () => {
    const s = withTabs(2);
    expect(paneBySessionId(s, 77)).toBeUndefined();
    expect(tabBySessionId(s, 0)).toBeUndefined();
  });

  it("tabPaneIds returns panes in layout order", () => {
    let s = run({ kind: "openTab" }, { kind: "splitPane", tabId: 1, dir: "row" });
    s = reduceTabs(s, { kind: "focusPane", tabId: 1, paneId: 1 });
    s = reduceTabs(s, { kind: "splitPane", tabId: 1, dir: "column" }); // 1 → (1/3), so order 1,3,2
    expect(tabPaneIds(s.tabs[0])).toEqual([1, 3, 2]);
  });

  it("canSplitFocused reflects the layout-tree guard", () => {
    const s = run({ kind: "openTab" });
    const big = { x: 0, y: 0, width: 800, height: 600 };
    const tiny = { x: 0, y: 0, width: 100, height: 80 };
    expect(canSplitFocused(s.tabs[0], "row", big, { width: 80, height: 60 })).toBe(true);
    expect(canSplitFocused(s.tabs[0], "row", tiny, { width: 80, height: 60 })).toBe(false);
  });
});
