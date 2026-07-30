// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
// trmx-224: the shared tab/pane ID-reservation authority — the reducer mirror that lets
// every creator predict identities safely across awaited gaps (promise continuations can
// interleave with dispatched-but-uncommitted creations; stateRef lags commit).

import { describe, expect, it } from "vitest";

import { makeIdReservation } from "./idReservation";

describe("idReservation (trmx-224)", () => {
  it("mirrors the reducer action shapes: reserveTab advances both counters, reservePane only the pane counter", () => {
    // The round-7 blocker regression: openTab allocates a tab AND its pane; splitPane
    // allocates a pane ONLY. The sequence open → split → open must yield pane ids 1,2,3
    // and tab ids 1,2 — a zero-arg both-counters reserve would desynchronize on the split.
    const r = makeIdReservation({ nextTabId: 1, nextPaneId: 1 });
    const first = r.reserveTab();
    const split = r.reservePane();
    const second = r.reserveTab();
    expect(first).toEqual({ tabId: 1, paneId: 1 });
    expect(split).toEqual({ paneId: 2 });
    expect(second).toEqual({ tabId: 2, paneId: 3 });
  });

  it("starts from the provided counters (mid-session adoption)", () => {
    const r = makeIdReservation({ nextTabId: 7, nextPaneId: 42 });
    expect(r.reservePane()).toEqual({ paneId: 42 });
    expect(r.reserveTab()).toEqual({ tabId: 7, paneId: 43 });
  });

  it("reservations are strictly monotonic — no id is ever handed out twice", () => {
    const r = makeIdReservation({ nextTabId: 1, nextPaneId: 1 });
    const panes = [
      r.reserveTab().paneId,
      r.reservePane().paneId,
      r.reserveTab().paneId,
      r.reservePane().paneId,
    ];
    expect(new Set(panes).size).toBe(panes.length);
    expect([...panes].sort((a, b) => a - b)).toEqual(panes);
  });
});
