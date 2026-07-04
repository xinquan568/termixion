// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-74 (test-first): the pure tab reducer. Every transition the tab bar needs — open, attach,
// close (iTerm2 right-then-left activation), activate, wrap-around next/prev, ⌘1..⌘9 selectIndex
// (index 8 = LAST tab, the iTerm2 ⌘9 rule), drag reorder — is pinned here headless: no React, no
// DOM, just state in / state out. No-op transitions must return the IDENTICAL state object (===)
// so a React reducer consumer skips the re-render.
//
// trmx-75 (FR-2.4) extends the model with per-tab title SOURCES (manual > OSC > process >
// fallback, see tabTitle.ts) reduced through `setTitleSource`; `Tab.title` stays THE one rendered
// string, now always recomputed as the effective title over those sources.
import { describe, it, expect } from "vitest";
import {
  initialTabsState,
  reduceTabs,
  tabBySessionId,
  type Tab,
  type TabsAction,
  type TabsState,
} from "./tabState";

/** Reduce a fresh initial state through `actions` in order. */
function run(...actions: TabsAction[]): TabsState {
  return actions.reduce(reduceTabs, initialTabsState());
}

/** A state with `n` open tabs (tabIds 1..n, the last one active). */
function withTabs(n: number): TabsState {
  return run(...Array.from({ length: n }, (): TabsAction => ({ kind: "openTab" })));
}

const tabIds = (state: TabsState) => state.tabs.map((t) => t.tabId);

// Freeze the state tree so any in-place mutation inside the reducer throws (purity guard).
function deepFreeze(state: TabsState): TabsState {
  state.tabs.forEach((t) => {
    Object.freeze(t.pane);
    Object.freeze(t.titleSources);
    Object.freeze(t);
  });
  Object.freeze(state.tabs);
  return Object.freeze(state);
}

describe("initialTabsState", () => {
  it("starts empty: no tabs, no active tab, ids from 1", () => {
    expect(initialTabsState()).toEqual({ tabs: [], activeTabId: null, nextTabId: 1 });
  });
});

describe("openTab", () => {
  it("appends a session-less pane with the default title and activates it", () => {
    const state = run({ kind: "openTab" });
    expect(state.tabs).toEqual<Tab[]>([
      { tabId: 1, title: "Shell", titleSources: { fallback: "Shell" }, pane: { sessionId: null } },
    ]);
    expect(state.activeTabId).toBe(1);
    expect(state.nextTabId).toBe(2);
  });

  it("honors an explicit title (seeded as the FALLBACK source, trmx-75)", () => {
    const state = run({ kind: "openTab", title: "build" });
    expect(state.tabs[0].title).toBe("build");
    expect(state.tabs[0].titleSources).toEqual({ fallback: "build" });
  });

  it("sanitizes the title arg at the boundary; a junk arg seeds the default fallback (trmx-75)", () => {
    expect(run({ kind: "openTab", title: "  build " }).tabs[0].title).toBe("build");
    const junk = run({ kind: "openTab", title: " \u{7} " });
    expect(junk.tabs[0].title).toBe("Shell");
    expect(junk.tabs[0].titleSources).toEqual({ fallback: "Shell" });
  });

  it("appends at the end and moves activation to the new tab", () => {
    const state = run({ kind: "openTab" }, { kind: "openTab" }, { kind: "openTab" });
    expect(tabIds(state)).toEqual([1, 2, 3]);
    expect(state.activeTabId).toBe(3);
    expect(state.nextTabId).toBe(4);
  });

  it("does not mutate the input state", () => {
    const before = deepFreeze(withTabs(2));
    expect(() => reduceTabs(before, { kind: "openTab" })).not.toThrow();
    expect(before.tabs).toHaveLength(2);
  });
});

describe("attachSession", () => {
  it("binds the sessionId and title to the tab's pane", () => {
    const state = run(
      { kind: "openTab" },
      { kind: "openTab" },
      { kind: "attachSession", tabId: 1, sessionId: 77, title: "zsh" },
    );
    expect(state.tabs[0]).toEqual({
      tabId: 1,
      title: "zsh",
      titleSources: { fallback: "zsh" }, // the session title becomes the FALLBACK source (trmx-75)
      pane: { sessionId: 77 },
    });
    // The sibling tab is untouched.
    expect(state.tabs[1]).toEqual({
      tabId: 2,
      title: "Shell",
      titleSources: { fallback: "Shell" },
      pane: { sessionId: null },
    });
  });

  // trmx-75: the attach refreshes the FALLBACK slot only — it must never demote a manual/OSC
  // title that raced ahead of the async open resolution.
  it("updates the fallback WITHOUT demoting a present OSC (or manual) title", () => {
    let state = run({ kind: "openTab" });
    state = reduceTabs(state, { kind: "setTitleSource", tabId: 1, source: "osc", value: "vim" });
    expect(state.tabs[0].title).toBe("vim");
    state = reduceTabs(state, { kind: "attachSession", tabId: 1, sessionId: 7, title: "zsh" });
    expect(state.tabs[0].title).toBe("vim"); // still the OSC title
    expect(state.tabs[0].pane.sessionId).toBe(7); // but the attach itself landed
    // Clearing the OSC title reveals the refreshed fallback.
    state = reduceTabs(state, { kind: "setTitleSource", tabId: 1, source: "osc", value: null });
    expect(state.tabs[0].title).toBe("zsh");
  });

  it("keeps the previous fallback when the attach title sanitizes to empty (junk-inert, trmx-75)", () => {
    const state = run(
      { kind: "openTab" },
      { kind: "attachSession", tabId: 1, sessionId: 7, title: " \u{1b} " },
    );
    expect(state.tabs[0].title).toBe("Shell");
    expect(state.tabs[0].titleSources).toEqual({ fallback: "Shell" });
    expect(state.tabs[0].pane.sessionId).toBe(7);
  });

  // The async open can resolve after the user already closed the tab: the reducer must not
  // resurrect it — it stays a no-op and the CALLER disposes the orphan session (trmx-74).
  it("is a no-op on a dead tab and returns the IDENTICAL state object", () => {
    const state = run({ kind: "openTab" }, { kind: "openTab" }, { kind: "closeTab", tabId: 1 });
    const next = reduceTabs(state, {
      kind: "attachSession",
      tabId: 1,
      sessionId: 77,
      title: "zsh",
    });
    expect(next).toBe(state);
  });

  it("is a no-op (===) on the empty state", () => {
    const state = initialTabsState();
    expect(
      reduceTabs(state, { kind: "attachSession", tabId: 1, sessionId: 1, title: "x" }),
    ).toBe(state);
  });
});

describe("setTitleSource (trmx-75, FR-2.4)", () => {
  /** One tab (tabId 1) with an attached session titled "zsh" — fallback = "zsh". */
  function attached(): TabsState {
    return run(
      { kind: "openTab" },
      { kind: "attachSession", tabId: 1, sessionId: 7, title: "zsh" },
    );
  }

  /** Shorthand: set (or clear, value=null) one title slot on tab 1. */
  function set(
    state: TabsState,
    source: "manual" | "osc" | "process",
    value: string | null,
  ): TabsState {
    return reduceTabs(state, { kind: "setTitleSource", tabId: 1, source, value });
  }

  const title = (state: TabsState) => state.tabs[0].title;

  it("renders the precedence chain end to end: attach, then OSC, then a process hint", () => {
    let s = attached();
    expect(title(s)).toBe("zsh"); // fallback only
    s = set(s, "process", "sleep");
    expect(title(s)).toBe("sleep"); // process beats fallback
    s = set(s, "osc", "vim");
    expect(title(s)).toBe("vim"); // OSC beats process — and STAYS on later hints
    s = set(s, "process", "node");
    expect(title(s)).toBe("vim");
  });

  it("manual overrides OSC, process, and fallback", () => {
    let s = attached();
    s = set(s, "osc", "vim");
    s = set(s, "process", "sleep");
    s = set(s, "manual", "work");
    expect(title(s)).toBe("work");
    s = set(s, "osc", "emacs"); // even a NEWER OSC title cannot displace the rename
    expect(title(s)).toBe("work");
  });

  // The review's load-bearing pin: the 1 Hz poller must never be able to stomp on what the user
  // or the program explicitly chose — the hint only waits UNDERNEATH for its turn.
  it("a process hint can NEVER clobber a manual or OSC title", () => {
    let s = attached();
    s = set(s, "manual", "work");
    s = set(s, "process", "sleep");
    expect(title(s)).toBe("work");

    let t = attached();
    t = set(t, "osc", "vim");
    t = set(t, "process", "sleep");
    expect(title(t)).toBe("vim");
    // ...but the hint WAS recorded: clearing the OSC title reveals it.
    t = set(t, "osc", null);
    expect(title(t)).toBe("sleep");
  });

  it("clearing cascades down the precedence chain: manual → OSC → process → fallback", () => {
    let s = attached();
    s = set(s, "process", "sleep");
    s = set(s, "osc", "vim");
    s = set(s, "manual", "work");
    expect(title(s)).toBe("work");
    s = set(s, "manual", null); // clear-to-auto (empty rename commit)
    expect(title(s)).toBe("vim");
    s = set(s, "osc", null);
    expect(title(s)).toBe("sleep");
    s = set(s, "process", null);
    expect(title(s)).toBe("zsh");
    expect(s.tabs[0].titleSources).toEqual({ fallback: "zsh" }); // all slots really gone
  });

  it('an empty value clears the slot like null (programs reset titles with OSC "")', () => {
    let s = attached();
    s = set(s, "process", "sleep");
    s = set(s, "osc", "vim");
    expect(title(s)).toBe("vim");
    s = set(s, "osc", "");
    expect(title(s)).toBe("sleep");
    // A value that SANITIZES to empty (whitespace/controls only) clears the same way.
    s = set(s, "manual", "work");
    s = set(s, "manual", " \u{7} ");
    expect(title(s)).toBe("sleep");
  });

  it("sanitizes values at the reducer boundary and STORES them sanitized", () => {
    let s = attached();
    s = set(s, "manual", "  wo\u{0}rk\u{9f}  ");
    expect(title(s)).toBe("work");
    expect(s.tabs[0].titleSources.manual).toBe("work");
    s = set(s, "osc", "x".repeat(300));
    expect(s.tabs[0].titleSources.osc).toBe("x".repeat(256)); // capped in storage too
    expect(title(s)).toBe("work"); // manual still wins
  });

  it("retitles ONLY its own tab — the sibling is untouched", () => {
    let s = run(
      { kind: "openTab" },
      { kind: "openTab" },
      { kind: "attachSession", tabId: 2, sessionId: 9, title: "zsh" },
    );
    s = reduceTabs(s, { kind: "setTitleSource", tabId: 2, source: "osc", value: "vim" });
    expect(s.tabs[1].title).toBe("vim");
    expect(s.tabs[0].title).toBe("Shell");
    expect(s.tabs[0].titleSources).toEqual({ fallback: "Shell" });
  });

  it("is a no-op (===) on a dead tab, an unknown tab, and the empty state", () => {
    const s = run({ kind: "openTab" }, { kind: "openTab" }, { kind: "closeTab", tabId: 1 });
    expect(set(s, "manual", "work")).toBe(s); // tab 1 is dead
    expect(reduceTabs(s, { kind: "setTitleSource", tabId: 99, source: "osc", value: "x" })).toBe(s);
    const empty = initialTabsState();
    expect(
      reduceTabs(empty, { kind: "setTitleSource", tabId: 1, source: "process", value: "x" }),
    ).toBe(empty);
  });

  it("re-delivering the same value, or clearing an absent slot, is a no-op (===)", () => {
    const s = set(attached(), "process", "sleep");
    expect(set(s, "process", "sleep")).toBe(s); // identical hint re-delivered
    expect(set(s, "process", " sleep \u{7}")).toBe(s); // identical AFTER sanitization
    expect(set(s, "manual", null)).toBe(s); // clearing a slot that was never set
    expect(set(s, "osc", "  ")).toBe(s); // empty-clear of an absent slot
  });

  it("does not mutate the input state (purity guard)", () => {
    const before = deepFreeze(set(attached(), "osc", "vim"));
    expect(() => set(before, "manual", "work")).not.toThrow();
    expect(() => set(before, "osc", null)).not.toThrow();
    expect(title(before)).toBe("vim");
  });
});

describe("closeTab", () => {
  it("closing the active tab activates its RIGHT neighbor (iTerm2 rule)", () => {
    const state = reduceTabs(withTabs(3), { kind: "activateTab", tabId: 2 });
    const next = reduceTabs(state, { kind: "closeTab", tabId: 2 });
    expect(tabIds(next)).toEqual([1, 3]);
    expect(next.activeTabId).toBe(3); // the right neighbor, not the left
  });

  it("closing the active LAST tab falls back to the LEFT neighbor", () => {
    const state = withTabs(3); // active = 3 (the last opened)
    const next = reduceTabs(state, { kind: "closeTab", tabId: 3 });
    expect(tabIds(next)).toEqual([1, 2]);
    expect(next.activeTabId).toBe(2);
  });

  it("closing an INACTIVE tab keeps the active tab", () => {
    const state = withTabs(3); // active = 3
    const next = reduceTabs(state, { kind: "closeTab", tabId: 1 });
    expect(tabIds(next)).toEqual([2, 3]);
    expect(next.activeTabId).toBe(3);
  });

  it("closing the only tab leaves the empty state (activeTabId null)", () => {
    const state = withTabs(1);
    const next = reduceTabs(state, { kind: "closeTab", tabId: 1 });
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
      { kind: "openTab" }, // id 1
      { kind: "openTab" }, // id 2
      { kind: "closeTab", tabId: 2 },
      { kind: "closeTab", tabId: 1 },
      { kind: "openTab" }, // must be id 3, not a recycled 1
    );
    expect(tabIds(state)).toEqual([3]);
    expect(state.nextTabId).toBe(4);
  });
});

describe("activateTab", () => {
  it("activates an existing tab", () => {
    const state = withTabs(3);
    expect(reduceTabs(state, { kind: "activateTab", tabId: 1 }).activeTabId).toBe(1);
  });

  it("is a no-op (===) for an absent tab and for the already-active tab", () => {
    const state = withTabs(3); // active = 3
    expect(reduceTabs(state, { kind: "activateTab", tabId: 99 })).toBe(state);
    expect(reduceTabs(state, { kind: "activateTab", tabId: 3 })).toBe(state);
    const empty = initialTabsState();
    expect(reduceTabs(empty, { kind: "activateTab", tabId: 1 })).toBe(empty);
  });
});

describe("nextTab / prevTab", () => {
  it("cycle through neighbors", () => {
    const state = reduceTabs(withTabs(3), { kind: "activateTab", tabId: 1 });
    expect(reduceTabs(state, { kind: "nextTab" }).activeTabId).toBe(2);
    expect(reduceTabs(reduceTabs(state, { kind: "nextTab" }), { kind: "nextTab" }).activeTabId).toBe(3);
  });

  it("nextTab wraps from the last tab to the first", () => {
    const state = withTabs(3); // active = 3 (last)
    expect(reduceTabs(state, { kind: "nextTab" }).activeTabId).toBe(1);
  });

  it("prevTab wraps from the first tab to the last", () => {
    const state = reduceTabs(withTabs(3), { kind: "activateTab", tabId: 1 });
    expect(reduceTabs(state, { kind: "prevTab" }).activeTabId).toBe(3);
  });

  it("are no-ops (===) on the empty state and with a single tab (wrap to self)", () => {
    const empty = initialTabsState();
    expect(reduceTabs(empty, { kind: "nextTab" })).toBe(empty);
    expect(reduceTabs(empty, { kind: "prevTab" })).toBe(empty);
    const one = withTabs(1);
    expect(reduceTabs(one, { kind: "nextTab" })).toBe(one);
    expect(reduceTabs(one, { kind: "prevTab" })).toBe(one);
  });
});

describe("selectIndex (⌘1..⌘9)", () => {
  it("activates the 0-based index", () => {
    const state = withTabs(3);
    expect(reduceTabs(state, { kind: "selectIndex", index: 0 }).activeTabId).toBe(1);
    expect(reduceTabs(state, { kind: "selectIndex", index: 1 }).activeTabId).toBe(2);
  });

  it("index 8 (⌘9) selects the LAST tab even with only 3 tabs (iTerm2 rule)", () => {
    const state = reduceTabs(withTabs(3), { kind: "activateTab", tabId: 1 });
    expect(reduceTabs(state, { kind: "selectIndex", index: 8 }).activeTabId).toBe(3);
  });

  it("index 8 (⌘9) selects the LAST tab even when more than 9 tabs exist", () => {
    const state = reduceTabs(withTabs(10), { kind: "activateTab", tabId: 1 });
    expect(reduceTabs(state, { kind: "selectIndex", index: 8 }).activeTabId).toBe(10);
  });

  it("other out-of-range indices are no-ops (===)", () => {
    const state = withTabs(3); // active = 3
    expect(reduceTabs(state, { kind: "selectIndex", index: 5 })).toBe(state);
    expect(reduceTabs(state, { kind: "selectIndex", index: -1 })).toBe(state);
    const empty = initialTabsState();
    expect(reduceTabs(empty, { kind: "selectIndex", index: 0 })).toBe(empty);
    expect(reduceTabs(empty, { kind: "selectIndex", index: 8 })).toBe(empty);
  });

  it("selecting the already-active index is a no-op (===)", () => {
    const state = withTabs(3); // active = 3, at index 2
    expect(reduceTabs(state, { kind: "selectIndex", index: 2 })).toBe(state);
  });
});

describe("moveTab", () => {
  it("reorders forward and backward", () => {
    const state = withTabs(3); // [1, 2, 3]
    expect(tabIds(reduceTabs(state, { kind: "moveTab", from: 0, to: 2 }))).toEqual([2, 3, 1]);
    expect(tabIds(reduceTabs(state, { kind: "moveTab", from: 2, to: 0 }))).toEqual([3, 1, 2]);
  });

  it("preserves the active tab's IDENTITY across a reorder", () => {
    const state = reduceTabs(withTabs(3), { kind: "activateTab", tabId: 1 });
    const next = reduceTabs(state, { kind: "moveTab", from: 0, to: 2 });
    expect(next.activeTabId).toBe(1); // still tab 1, now at another index
    expect(tabIds(next)).toEqual([2, 3, 1]);
  });

  it("clamps an out-of-range destination", () => {
    const state = withTabs(3);
    expect(tabIds(reduceTabs(state, { kind: "moveTab", from: 0, to: 99 }))).toEqual([2, 3, 1]);
    expect(tabIds(reduceTabs(state, { kind: "moveTab", from: 2, to: -5 }))).toEqual([3, 1, 2]);
  });

  it("is a no-op (===) for an out-of-range source, a same-slot move, and the empty state", () => {
    const state = withTabs(3);
    expect(reduceTabs(state, { kind: "moveTab", from: 3, to: 0 })).toBe(state);
    expect(reduceTabs(state, { kind: "moveTab", from: -1, to: 0 })).toBe(state);
    expect(reduceTabs(state, { kind: "moveTab", from: 1, to: 1 })).toBe(state);
    // A destination that clamps back onto the source slot is the same no-op.
    expect(reduceTabs(state, { kind: "moveTab", from: 2, to: 99 })).toBe(state);
    const empty = initialTabsState();
    expect(reduceTabs(empty, { kind: "moveTab", from: 0, to: 1 })).toBe(empty);
  });

  it("does not mutate the input state", () => {
    const before = deepFreeze(withTabs(3));
    expect(() => reduceTabs(before, { kind: "moveTab", from: 0, to: 2 })).not.toThrow();
    expect(tabIds(before)).toEqual([1, 2, 3]);
  });
});

// trmx-81 (FR-2.2): AXIS-FREEDOM — moveTab is pure splice semantics over the tab ORDER. The
// reducer never sees an axis: whether TabStrip mapped the pointer's X (horizontal bar) or Y
// (vertical rail) onto the slots, the same {from, to} yields the same state. These tests document
// that contract for the vertical case — deliberately NO reducer change ships with them.
describe("moveTab axis-freedom (trmx-81)", () => {
  it("a vertical drag's slots reorder identically to a horizontal drag's (same splice)", () => {
    const state = withTabs(3); // [1, 2, 3] — rendered as a vertical rail, slots top-to-bottom
    // Dragging the TOP tab past the bottom tab's Y midpoint = {from: 0, to: 2}, exactly what a
    // rightward drag on a horizontal strip produces.
    const down = reduceTabs(state, { kind: "moveTab", from: 0, to: 2 });
    expect(tabIds(down)).toEqual([2, 3, 1]);
    // And the BOTTOM tab dragged up to the top slot.
    const up = reduceTabs(state, { kind: "moveTab", from: 2, to: 0 });
    expect(tabIds(up)).toEqual([3, 1, 2]);
  });

  it("vertical no-ops match horizontal no-ops: a same-slot drop is the identical state (===)", () => {
    const state = withTabs(3);
    // A vertical drag that returns to its own row commits nothing…
    expect(reduceTabs(state, { kind: "moveTab", from: 1, to: 1 })).toBe(state);
    // …and a drag past the rail's end clamps onto the last slot (same clamp as horizontal).
    expect(tabIds(reduceTabs(state, { kind: "moveTab", from: 0, to: 99 }))).toEqual([2, 3, 1]);
  });

  it("activation identity survives a vertical reorder (identity, not row index)", () => {
    const state = reduceTabs(withTabs(3), { kind: "activateTab", tabId: 1 });
    const next = reduceTabs(state, { kind: "moveTab", from: 0, to: 2 });
    expect(next.activeTabId).toBe(1); // still tab 1, now the bottom row
  });
});

describe("tabBySessionId", () => {
  it("finds the tab bound to a session", () => {
    const state = run(
      { kind: "openTab" },
      { kind: "openTab" },
      { kind: "attachSession", tabId: 2, sessionId: 77, title: "zsh" },
    );
    expect(tabBySessionId(state, 77)?.tabId).toBe(2);
  });

  it("returns undefined for an unknown session and never matches session-less panes", () => {
    const state = withTabs(2); // both panes have sessionId null
    expect(tabBySessionId(state, 77)).toBeUndefined();
    // A null-pane tab must not be matched by any numeric probe.
    expect(tabBySessionId(state, 0)).toBeUndefined();
  });
});
