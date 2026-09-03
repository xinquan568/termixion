// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: the close concern — pane/tab teardown, the confirm-before-close gate, and the trmx-144
// quit handshake. Pure logic: no state, no refs, no effects.
//
// Close-time cleanup is SPLIT, and the split is deliberate rather than incidental: a symbol walk
// shows `disposePaneResources` clears flash and search only, while rename and badge are cleared by
// its CALLERS (`closeTabInternal` / `closePaneInternal`). The root passes each setter in, and the
// activity concern's `clearForPane` is composed here — so no hook reaches into another's state.

import type { Dispatch, SetStateAction } from "react";
import { isAskGeneration } from "../ipc/appEvents";
import { log } from "../ipc/logSink";
import {
  collectBusyPanes,
  collectBusyTabs,
  paneIsBusy,
  shouldConfirmClose,
  type BusyLookup,
} from "../panes/closeGuard";
import type { PaneId } from "../panes/layoutTree";
import { useSettingsStore } from "../store/settingsRuntimeContext";
import { paneBySessionId, tabPaneIds, type TabsAction, type TabsState } from "../tabs/tabState";
import type { CloseOpts, PendingClose } from "./closeContracts";
import type { PaneRuntimes } from "./paneRuntime";

export type CloseSeams = {
  closeSession: (sessionId: number) => Promise<void>;
  closeWindow: () => void;
  quitConfirmed: () => void;
  closeAcknowledged: (generation: number) => Promise<void>;
};

export type CloseGuardDeps = {
  runtimesRef: { current: PaneRuntimes };
  stateRef: { current: TabsState };
  seamsRef: { current: CloseSeams };
  pendingCloseRef: { current: PendingClose | null };
  quitAuthorizedRef: { current: boolean };
  dispatch: Dispatch<TabsAction>;
  setPendingClose: (next: PendingClose | null) => void;
  setFlashingPanes: (update: (prev: Set<PaneId>) => Set<PaneId>) => void;
  setOpenSearchPanes: (update: (prev: Set<PaneId>) => Set<PaneId>) => void;
  /** Cleared by the CALLERS, not by disposePaneResources — see the header note. */
  setRenamingTabId: Dispatch<SetStateAction<number | null>>;
  setBadgingPaneId: Dispatch<SetStateAction<PaneId | null>>;
  observeCloseRequested: (on: (generation: number) => void) => () => void;
  observePtyExited: (on: (sessionId: number) => void) => () => void;
};

export type CloseGuard = {
  disposePaneResources: (paneId: PaneId, opts?: { alreadyExited?: boolean }) => void;
  setPendingCloseSynced: (next: PendingClose | null) => void;
  bypassesConfirm: (opts?: CloseOpts) => boolean;
  closeTabInternal: (tabId: number, opts?: CloseOpts) => void;
  closePaneInternal: (tabId: number, paneId: PaneId, opts?: CloseOpts) => void;
  confirmPendingClose: (dontAskAgain: boolean) => void;
  cancelPendingClose: () => void;
  /** Read by E10's control bridge, outside the close region — so it is an output, not a local. */
  busyLookup: BusyLookup;
  /** E11's body — the trmx-144 `close:requested` handshake. Returns its teardown. */
  onCloseRequested: () => () => void;
  /** E05's pty-exited subscription. Returns its teardown. */
  closePaneOnPtyExit: () => () => void;
};

export function useCloseGuard(deps: CloseGuardDeps): CloseGuard {
  const {
    runtimesRef, stateRef, seamsRef, pendingCloseRef, quitAuthorizedRef, dispatch,
    setPendingClose, setFlashingPanes, setOpenSearchPanes, setRenamingTabId, setBadgingPaneId,
    observeCloseRequested, observePtyExited,
  } = deps;
  // trmx-253 (T3.4): the confirm-close preference is read off THIS window's runtime store rather
  // than the deleted `makeSettingsStore()` free function (which resolved to a module global).
  const settings = useSettingsStore();

  const disposePaneResources = (paneId: PaneId, opts?: { alreadyExited?: boolean }) => {
    // trmx-248: one call drops the record and clears BOTH timers (activity + exit-flash), and hands
    // back the session id captured before the drop. What it deliberately does not do is the two
    // halves a ref-held store cannot own — the React state removals below — and the backend close.
    const { sessionId } = runtimesRef.current.dispose(paneId);
    setFlashingPanes((prev) => {
      if (!prev.has(paneId)) return prev;
      const next = new Set(prev);
      next.delete(paneId);
      return next;
    });
    // trmx-98: drop this pane's find-bar state so a closed pane leaves no open bar. Load-bearing:
    // `openSearchRef.current.size` gates focus-follows-mouse GLOBALLY, so a stale entry would
    // suppress it for every pane.
    setOpenSearchPanes((prev) => {
      if (!prev.has(paneId)) return prev;
      const next = new Set(prev);
      next.delete(paneId);
      return next;
    });
    if (sessionId !== undefined && !opts?.alreadyExited) {
      seamsRef.current.closeSession(sessionId).catch((err: unknown) => {
        log.error("close pty failed", err);
      });
    }
  };

  // trmx-144: set the pending confirm dialog through ONE path so the render state and its
  // out-of-render mirror can never drift.
  const setPendingCloseSynced = (next: PendingClose | null) => {
    pendingCloseRef.current = next;
    setPendingClose(next);
  };

  // trmx-144: the per-pane reads the closeGuard aggregators need — the RAW debounce state (an
  // in-flight job counts even before the cosmetic line shows) and a display name (the foreground-
  // process hint, falling back to the pane's effective title). PaneIds are global-unique, so the
  // cross-tab scan can't alias.
  const busyLookup: BusyLookup = {
    activityState: (paneId) => runtimesRef.current.get(paneId)?.activity,
    displayName: (paneId) => {
      for (const tab of stateRef.current.tabs) {
        const pane = tab.panes[paneId];
        if (pane) return pane.titleSources.process ?? pane.title;
      }
      return undefined;
    },
  };

  // trmx-144: whether a close skips the confirm gate outright — the session already exited (nothing
  // left to protect), a remote controller asked (a dialog would deadlock a headless caller), or the
  // user just confirmed this very close in the dialog.
  const bypassesConfirm = (opts?: CloseOpts): boolean =>
    opts?.alreadyExited === true || opts?.origin === "remote" || opts?.confirmed === true;

  // Close a whole tab (all its panes) — the tab-strip × and the last-pane fallthrough. The LAST tab
  // closes the WINDOW instead (no dispatch, no per-session close — the backend's CloseRequested
  // kill_all owns cleanup). Otherwise drop the tab and dispose every pane's resources.
  const closeTabInternal = (tabId: number, opts?: CloseOpts) => {
    const s = stateRef.current;
    const tab = s.tabs.find((t) => t.tabId === tabId);
    if (!tab) return;
    // trmx-144: the confirm gate — a user-initiated close of a tab holding a busy pane prompts
    // instead of closing (per terminal.confirmClose, read fresh at close time).
    if (!bypassesConfirm(opts)) {
      if (pendingCloseRef.current !== null) return; // a confirm is already up — swallow the repeat
      const report = collectBusyPanes(tab, busyLookup);
      if (shouldConfirmClose(settings.get("terminal.confirmClose"), report.busy, "user")) {
        setPendingCloseSynced({ kind: "tab", tabId, names: report.names });
        return; // the dialog's onConfirm re-enters with { confirmed: true }
      }
    }
    if (s.tabs.length <= 1) {
      // trmx-144: the last tab closing the window IS the quit, and this gesture was already gated
      // (or bypassed) above — authorize it so the backend's close:requested round-trip for this
      // very close never prompts a second time.
      quitAuthorizedRef.current = true;
      seamsRef.current.closeWindow();
      return;
    }
    const paneIds = tabPaneIds(tab);
    dispatch({ kind: "closeTab", tabId });
    for (const paneId of paneIds) disposePaneResources(paneId, opts);
    // A tab dying MID-RENAME must clear the rename state, or a stuck renamingTabId would suppress
    // focus-follows-activation forever.
    setRenamingTabId((current) => (current === tabId ? null : current));
    // trmx-90: same for a tab dying MID-BADGE-EDIT — clear the editor if the badging pane was in it.
    setBadgingPaneId((current) => (current !== null && paneIds.includes(current) ? null : current));
  };

  // Close one pane with the ⌘W precedence: pane → tab → window. More than one pane → drop just that
  // pane (its sibling re-lays out, sessions untouched). The LAST pane of a tab closes the whole tab
  // (which may be the last tab → the window).
  const closePaneInternal = (tabId: number, paneId: PaneId, opts?: CloseOpts) => {
    const s = stateRef.current;
    const tab = s.tabs.find((t) => t.tabId === tabId);
    if (!tab || tab.panes[paneId] === undefined) return;
    // trmx-144: the confirm gate — a user-initiated close of a RAW-busy pane prompts instead of
    // closing. The name is included only when busy (the "always" dialog on an idle pane asks the
    // bare question — nothing is "still running").
    if (!bypassesConfirm(opts)) {
      if (pendingCloseRef.current !== null) return; // a confirm is already up — swallow the repeat
      const busy = paneIsBusy(runtimesRef.current.get(paneId)?.activity, tab.panes[paneId].activityVisible);
      if (shouldConfirmClose(settings.get("terminal.confirmClose"), busy, "user")) {
        const name = busy ? busyLookup.displayName(paneId)?.trim() : undefined;
        setPendingCloseSynced({ kind: "pane", tabId, paneId, names: name ? [name] : [] });
        return; // the dialog's onConfirm re-enters with { confirmed: true }
      }
    }
    if (tabPaneIds(tab).length > 1) {
      // A pane dying mid-rename (it is the focused/renamed pane) must clear the rename, or the input
      // would survive and re-target the NEW focused pane on commit. The whole-tab branch clears it
      // in closeTabInternal; the pane branch must do the same for the focused pane.
      const wasRenamedPane = tab.focusedPaneId === paneId;
      dispatch({ kind: "closePane", tabId, paneId });
      disposePaneResources(paneId, opts);
      if (wasRenamedPane) setRenamingTabId((current) => (current === tabId ? null : current));
      // trmx-90: a pane dying MID-BADGE-EDIT clears the editor so it can't re-target the new focus.
      setBadgingPaneId((current) => (current === paneId ? null : current));
    } else {
      closeTabInternal(tabId, opts);
    }
  };

  // Open a new tab inheriting the ACTIVE tab's FOCUSED pane cwd (or `cwdOverride` when given —
  // trmx-224 service tabs open at the requested dir). The cwd is keyed by the pane id RESERVED
  // for this dispatch (idReservation — never read from commit-lagged stateRef), and the
  // allocated ids are returned so callers can key further metadata / activate the tab.

  const confirmPendingClose = (dontAskAgain: boolean) => {
    const pending = pendingCloseRef.current;
    if (pending === null) return;
    if (dontAskAgain) settings.set("terminal.confirmClose", "never");
    setPendingCloseSynced(null);
    if (pending.kind === "quit") {
      quitAuthorizedRef.current = true;
      seamsRef.current.quitConfirmed();
      return;
    }
    if (pending.tabId === undefined) return;
    const tab = stateRef.current.tabs.find((t) => t.tabId === pending.tabId);
    if (!tab) return;
    if (pending.kind === "pane") {
      if (pending.paneId === undefined || tab.panes[pending.paneId] === undefined) return;
      closePaneInternal(pending.tabId, pending.paneId, { confirmed: true });
    } else {
      closeTabInternal(pending.tabId, { confirmed: true });
    }
  };
  const cancelPendingClose = () => setPendingCloseSynced(null);

  const onCloseRequested = () => {
    return observeCloseRequested((generation) => {
      // Validate at the seam too, not only in the real listener: `observeCloseRequested` is an
      // injection point, so the consumer must not trust the generation it is handed.
      if (!isAskGeneration(generation)) return;
      // trmx-268: prove liveness BEFORE answering, and do it even when a dialog is already up — a
      // webview showing the dialog is demonstrably alive and must not be read as hung by the next
      // gesture. The answer is chained onto the ack so it can never land first.
      void seamsRef.current.closeAcknowledged(generation).then(() => {
        if (quitAuthorizedRef.current) {
          seamsRef.current.quitConfirmed();
          return;
        }
        if (pendingCloseRef.current !== null) return;
        const report = collectBusyTabs(stateRef.current.tabs, busyLookup);
        if (shouldConfirmClose(settings.get("terminal.confirmClose"), report.busy, "user")) {
          setPendingCloseSynced({ kind: "quit", names: report.names, busyTabCount: report.busyTabCount });
        } else {
          seamsRef.current.quitConfirmed();
        }
      });
    });
  };

  const closePaneOnPtyExit = () =>
    observePtyExited((sessionId) => {
      const hit = paneBySessionId(stateRef.current, sessionId);
      if (hit) closePaneInternal(hit.tab.tabId, hit.paneId, { alreadyExited: true });
    });

  return {
    disposePaneResources, setPendingCloseSynced, bypassesConfirm,
    closeTabInternal, closePaneInternal, confirmPendingClose, cancelPendingClose,
    onCloseRequested, closePaneOnPtyExit, busyLookup,
  };
}
