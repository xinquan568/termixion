// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-144 (test-first): the pure close-confirmation policy. shouldConfirmClose is pinned by the
// FULL 18-row table (3 settings x busy/idle x 3 origins) — only a USER-initiated close of a busy
// pane ("when-busy") or any user close ("always") confirms; remote/auto closes NEVER prompt (a
// control-channel or session-exit close must not deadlock on a dialog). Busy aggregation reads the
// RAW isBusy flag from the live debounce state and falls back to the reducer's activityVisible
// mirror only when no state exists.
import { describe, expect, it } from "vitest";
import {
  collectBusyPanes,
  collectBusyTabs,
  paneIsBusy,
  shouldConfirmClose,
  type BusyLookup,
  type BusyTabLike,
  type CloseOrigin,
  type ConfirmCloseSetting,
} from "./closeGuard";
import { initialActivity, onBusyChange, onDeadline, type ActivityState } from "./activityLine";
import { leafNode, splitLeaf } from "./layoutTree";

// Real machine states, driven through the actual debounce (no hand-built phases):
const IDLE = initialActivity();
// busy@0, before the 150 ms show floor — RAW busy, line not yet visible.
const PENDING_SHOW = onBusyChange(initialActivity(), true, 0).state;
// busy@0 -> shown@150 — busy AND visible.
const VISIBLE_BUSY = onDeadline(PENDING_SHOW, 150).state;
// idle@200 during the min-visible hold — line still up, RAW busy is OFF.
const LINGERING = onBusyChange(VISIBLE_BUSY, false, 200).state;

describe("shouldConfirmClose (trmx-144): the full 18-row table", () => {
  const rows: Array<[ConfirmCloseSetting, boolean, CloseOrigin, boolean]> = [
    // setting, busy, origin, expected
    ["never", true, "user", false],
    ["never", false, "user", false],
    ["never", true, "remote", false],
    ["never", false, "remote", false],
    ["never", true, "auto", false],
    ["never", false, "auto", false],
    ["when-busy", true, "user", true],
    ["when-busy", false, "user", false],
    ["when-busy", true, "remote", false],
    ["when-busy", false, "remote", false],
    ["when-busy", true, "auto", false],
    ["when-busy", false, "auto", false],
    ["always", true, "user", true],
    ["always", false, "user", true],
    ["always", true, "remote", false],
    ["always", false, "remote", false],
    ["always", true, "auto", false],
    ["always", false, "auto", false],
  ];

  it.each(rows)(
    "setting=%s busy=%s origin=%s -> %s",
    (setting, busy, origin, expected) => {
      expect(shouldConfirmClose(setting, busy, origin)).toBe(expected);
    },
  );
});

describe("paneIsBusy (trmx-144): live state wins, activityVisible only a fallback", () => {
  it("reads the RAW busy flag when a debounce state exists", () => {
    expect(paneIsBusy(PENDING_SHOW, false)).toBe(true); // pre-show: busy though nothing painted
    expect(paneIsBusy(VISIBLE_BUSY, false)).toBe(true);
    expect(paneIsBusy(IDLE, true)).toBe(false); // state present -> fallback ignored
  });

  it("ignores the fallback during the linger (state says idle even though the line is up)", () => {
    // The reducer's activityVisible mirror is still true during the min-visible hold — the RAW
    // state must win, so a close during the linger is NOT guarded.
    expect(paneIsBusy(LINGERING, true)).toBe(false);
  });

  it("falls back to activityVisible === true only when no state exists", () => {
    expect(paneIsBusy(undefined, true)).toBe(true);
    expect(paneIsBusy(undefined, false)).toBe(false);
    expect(paneIsBusy(undefined, undefined)).toBe(false);
  });
});

// A three-pane tab (leaves order [1, 2, 3]) with injectable per-pane activity + names.
function makeTab(panes: Record<number, { activityVisible?: boolean }>): BusyTabLike {
  const tree = splitLeaf(splitLeaf(leafNode(1), 1, "row", 2), 2, "column", 3);
  return { tree, panes };
}

function makeLookup(
  states: Record<number, ActivityState | undefined>,
  names: Record<number, string | undefined>,
): BusyLookup {
  return {
    activityState: (paneId) => states[paneId],
    displayName: (paneId) => names[paneId],
  };
}

describe("collectBusyPanes (trmx-144)", () => {
  it("reports no busy panes on an all-idle tab", () => {
    const tab = makeTab({ 1: {}, 2: {}, 3: {} });
    const lookup = makeLookup({ 1: IDLE, 2: IDLE, 3: IDLE }, { 1: "vim", 2: "cargo", 3: "top" });
    expect(collectBusyPanes(tab, lookup)).toEqual({ busy: false, names: [] });
  });

  it("collects the busy panes' names in layout order, raw-busy only", () => {
    // Pane 1 busy pre-show, pane 2 lingering (line up but idle — NOT busy), pane 3 busy visible.
    const tab = makeTab({ 1: {}, 2: { activityVisible: true }, 3: {} });
    const lookup = makeLookup(
      { 1: PENDING_SHOW, 2: LINGERING, 3: VISIBLE_BUSY },
      { 1: "vim", 2: "cargo", 3: "top" },
    );
    expect(collectBusyPanes(tab, lookup)).toEqual({ busy: true, names: ["vim", "top"] });
  });

  it("uses the activityVisible fallback for a pane with no debounce state", () => {
    const tab = makeTab({ 1: { activityVisible: true }, 2: {}, 3: { activityVisible: false } });
    const lookup = makeLookup({}, { 1: "ssh", 2: "cargo", 3: "top" });
    expect(collectBusyPanes(tab, lookup)).toEqual({ busy: true, names: ["ssh"] });
  });

  it("degrades to busy with no name when the lookup has none (dialog shows just the question)", () => {
    const tab = makeTab({ 1: {}, 2: {}, 3: {} });
    const lookup = makeLookup({ 1: VISIBLE_BUSY, 2: IDLE, 3: IDLE }, {});
    expect(collectBusyPanes(tab, lookup)).toEqual({ busy: true, names: [] });
  });

  it("drops a blank name and dedupes repeats", () => {
    const tab = makeTab({ 1: {}, 2: {}, 3: {} });
    const lookup = makeLookup(
      { 1: VISIBLE_BUSY, 2: VISIBLE_BUSY, 3: VISIBLE_BUSY },
      { 1: "vim", 2: "  ", 3: "vim" },
    );
    expect(collectBusyPanes(tab, lookup)).toEqual({ busy: true, names: ["vim"] });
  });
});

describe("collectBusyTabs (trmx-144): the all-tabs quit aggregate", () => {
  it("is quiet over no tabs", () => {
    expect(collectBusyTabs([], makeLookup({}, {}))).toEqual({
      busy: false,
      busyTabCount: 0,
      names: [],
    });
  });

  it("counts only tabs with at least one raw-busy pane and merges names, deduped", () => {
    const idleTab = makeTab({ 1: {}, 2: {}, 3: {} });
    const busyTab: BusyTabLike = {
      tree: splitLeaf(leafNode(4), 4, "row", 5),
      panes: { 4: {}, 5: {} },
    };
    const otherBusyTab: BusyTabLike = { tree: leafNode(6), panes: { 6: {} } };
    const lookup = makeLookup(
      { 1: IDLE, 2: IDLE, 3: IDLE, 4: VISIBLE_BUSY, 5: PENDING_SHOW, 6: VISIBLE_BUSY },
      { 4: "vim", 5: "cargo", 6: "vim" },
    );
    expect(collectBusyTabs([idleTab, busyTab, otherBusyTab], lookup)).toEqual({
      busy: true,
      busyTabCount: 2,
      names: ["vim", "cargo"],
    });
  });
});
