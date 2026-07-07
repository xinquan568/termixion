// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-144: the PURE close-confirmation policy (no React, no DOM) — kitty-style confirm-before-
// closing a busy pane / tab / the app. Two halves:
//
// 1. shouldConfirmClose — the decision table. Only a USER-initiated close ever prompts: a remote
//    close (control channel / CLI) must never deadlock a headless caller on a dialog, and an auto
//    close (the session exited on its own) has nothing left to protect. Within a user close the
//    setting rules: "never" -> no prompt, "always" -> always prompt, "when-busy" -> prompt iff busy.
//
// 2. Busy aggregation. "Busy" is the RAW isBusy flag of the pane's live debounce state
//    (activityLine.ts, App's activityStatesRef) — NOT the cosmetic activityVisible mirror, which
//    lags on both edges (150 ms pre-show, >=300 ms linger). The reducer's PaneState.activityVisible
//    (tabs/tabState.ts) is only a FALLBACK for a pane with no debounce state. Names come from an
//    injected lookup so this module stays decoupled from App's refs; App supplies each busy pane's
//    `titleSources.process` (the foreground-process hint from the 1 Hz poller — the actual running
//    program) falling back to the pane's effective `title`. A pane with no usable name is still
//    counted busy with no name — the dialog degrades to the bare question.
import { isBusy, type ActivityState } from "./activityLine";
import { leaves, type LayoutNode, type PaneId } from "./layoutTree";

/** The confirm_close_setting values (kitty's confirm_os_window_close family, reduced to a tri-state). */
export type ConfirmCloseSetting = "never" | "when-busy" | "always";

/** Who initiated the close: the user (key/menu/button), a remote controller, or the session itself. */
export type CloseOrigin = "user" | "remote" | "auto";

/** The full policy: prompt only for a user-initiated close, per the setting ("when-busy" reads `busy`). */
export function shouldConfirmClose(
  setting: ConfirmCloseSetting,
  busy: boolean,
  origin: CloseOrigin,
): boolean {
  if (origin !== "user") return false;
  if (setting === "never") return false;
  if (setting === "always") return true;
  return busy;
}

/**
 * One pane's RAW busy flag: the live debounce state when one exists (the truth — pre-show counts,
 * the linger does not), else the reducer's `activityVisible` mirror (=== true) as a fallback.
 */
export function paneIsBusy(
  state: ActivityState | undefined,
  activityVisibleFallback: boolean | undefined,
): boolean {
  if (state !== undefined) return isBusy(state);
  return activityVisibleFallback === true;
}

/** App-injected per-pane reads: the live debounce state and a display name for a busy pane. */
export interface BusyLookup {
  /** The pane's live debounce state (App's activityStatesRef), undefined when none exists. */
  activityState: (paneId: PaneId) => ActivityState | undefined;
  /** A human-readable running-program name (titleSources.process ?? title), undefined when none. */
  displayName: (paneId: PaneId) => string | undefined;
}

/** The structural slice of a Tab this module needs — a real tabState.Tab satisfies it as-is. */
export interface BusyTabLike {
  tree: LayoutNode;
  panes: Record<PaneId, { activityVisible?: boolean }>;
}

/** Busy aggregate: whether anything is busy, and the busy panes' display names (deduped, in order). */
export interface BusyReport {
  busy: boolean;
  names: string[];
}

/** Quit aggregate: the tab-level counts for "N tab(s) have running programs". */
export interface QuitBusyReport extends BusyReport {
  busyTabCount: number;
}

// Push a trimmed, non-empty, not-yet-seen name (blank / duplicate names add nothing to the dialog).
function pushName(names: string[], raw: string | undefined): void {
  const name = raw?.trim();
  if (name !== undefined && name !== "" && !names.includes(name)) names.push(name);
}

/**
 * Scan one tab's panes in LAYOUT order (leaves — never Object.keys, which is numeric-string order)
 * for raw-busy panes; collect their display names for the dialog.
 */
export function collectBusyPanes(tab: BusyTabLike, lookup: BusyLookup): BusyReport {
  let busy = false;
  const names: string[] = [];
  for (const paneId of leaves(tab.tree)) {
    const fallback = tab.panes[paneId]?.activityVisible;
    if (!paneIsBusy(lookup.activityState(paneId), fallback)) continue;
    busy = true;
    pushName(names, lookup.displayName(paneId));
  }
  return { busy, names };
}

/** The all-tabs variant for quit: how many tabs hold a busy pane, plus the merged deduped names. */
export function collectBusyTabs(
  tabs: readonly BusyTabLike[],
  lookup: BusyLookup,
): QuitBusyReport {
  let busyTabCount = 0;
  const names: string[] = [];
  for (const tab of tabs) {
    const report = collectBusyPanes(tab, lookup);
    if (!report.busy) continue;
    busyTabCount += 1;
    for (const name of report.names) pushName(names, name);
  }
  return { busy: busyTabCount > 0, busyTabCount, names };
}
