// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
// trmx-224: the shared tab/pane ID-reservation authority.
//
// Creators predict the ids the reducer WILL allocate so they can key side-channel metadata
// (pendingCwdRef, pendingScriptRef) before dispatching. Reading `stateRef.current.next*`
// for that prediction is only safe while nothing interleaves between read and dispatch —
// but stateRef advances on COMMIT, so a promise continuation (e.g. the service-paths take,
// trmx-224) can run between a creator's dispatch and its commit, observe the stale counters,
// and collide. This authority is the fix: counters that advance SYNCHRONOUSLY at
// reservation time, mirrored to the reducer's action shapes — one reservation per
// counter-advancing dispatch, made by the code that dispatches (never by wrappers, or a
// delegating caller would reserve twice for one dispatch).

/** What `openTab` allocates: a tab and its single pane. */
export interface ReservedTab {
  tabId: number;
  paneId: number;
}

/** What `splitPane` allocates: a pane only. */
export interface ReservedPane {
  paneId: number;
}

export interface IdReservation {
  /** Mirror of the `openTab` reducer action — advances BOTH counters. */
  reserveTab(): ReservedTab;
  /** Mirror of the `splitPane` reducer action — advances the pane counter only. */
  reservePane(): ReservedPane;
}

/** Build the authority seeded from the reducer's initial counters. */
export function makeIdReservation(init: { nextTabId: number; nextPaneId: number }): IdReservation {
  let nextTabId = init.nextTabId;
  let nextPaneId = init.nextPaneId;
  return {
    reserveTab: () => ({ tabId: nextTabId++, paneId: nextPaneId++ }),
    reservePane: () => ({ paneId: nextPaneId++ }),
  };
}
