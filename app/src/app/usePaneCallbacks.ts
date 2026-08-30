// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: the per-pane callback caches App.tsx used to hold inline. Pure logic: it owns no state,
// no refs and no effects — every one of those stays in the composition root, which passes this hook
// exactly the values the compiler says it reads.
//
// The identity guarantee is the whole point. `readyFor`/`oscTitleFor`/`badgeFor` are cached ON the
// pane's runtime record, so their identity never changes across App re-renders. TerminalView's
// effect re-runs when a callback identity changes, which remounts the terminal and reopens the PTY —
// the keep-alive assertions in App.test.tsx are what catch it.

import type { Dispatch } from "react";
import { log } from "../ipc/logSink";
import { formatAttachError, writePaneNotice } from "../terminal/appSeams";
import type { PaneId } from "../panes/layoutTree";
import type { TabsAction, TabsState } from "../tabs/tabState";
import type { TerminalHandle } from "../terminal/mountTerminal";
import type { CwdStore } from "../terminal/osc7";
import type { PaneRuntime, PaneRuntimes } from "./paneRuntime";

/** The App seams this hook reads. Declared here so the hook does not depend on App.tsx (L6 -> root). */
export type AppSeams = {
  attach: (handle: TerminalHandle, opts?: { cwd?: string }) => Promise<{ sessionId: number; title: string }>;
  closeSession: (sessionId: number) => Promise<void>;
  sendInput: (sessionId: number, data: string) => Promise<void>;
};

export type PaneCallbacksDeps = {
  paneOf: (paneId: PaneId) => PaneRuntime;
  setPaneField: <K extends keyof PaneRuntime>(paneId: PaneId, field: K, value: PaneRuntime[K]) => void;
  runtimesRef: { current: PaneRuntimes };
  /** Only the three members this hook actually reaches for — not the whole seam bag. */
  seamsRef: { current: Pick<AppSeams, "attach" | "closeSession" | "sendInput"> };
  dispatch: Dispatch<TabsAction>;
  stateRef: { current: TabsState };
  renamingRef: { current: number | null };
  badgingRef: { current: PaneId | null };
  openSearchRef: { current: Set<PaneId> };
};

export type PaneCallbacks = {
  storeFor: (paneId: PaneId) => CwdStore;
  readyFor: (tabId: number, paneId: PaneId) => (handle: TerminalHandle) => void;
  oscTitleFor: (tabId: number, paneId: PaneId) => (title: string) => void;
  badgeFor: (tabId: number, paneId: PaneId) => (badge: string | null) => void;
  /** E15's body: the focus-follows-activation grab, suppressed while an overlay owns the keyboard. */
  focusFocusedPane: (activeFocusedPaneId: PaneId | null) => void;
};

export function usePaneCallbacks(deps: PaneCallbacksDeps): PaneCallbacks {
  const {
    paneOf, setPaneField, runtimesRef, seamsRef, dispatch, stateRef,
    renamingRef, badgingRef, openSearchRef,
  } = deps;


  // This pane's cwd store, created lazily at RENDER time — so it exists from the terminal's mount
  // and an OSC 7 report (or a cwd-inheritance capture) can land before the session attaches.
  // trmx-248: this is the ONE place a pane's runtime record is created. Everywhere else reads with
  // `.get()` and handles `undefined` exactly as the old Maps' `.get()` did — so "no pane" stays
  // distinguishable from "pane with an unset field".
  const storeFor = (paneId: PaneId): CwdStore => paneOf(paneId).cwd;

  // Whether (tabId, paneId) is still live — the orphan guard's test at attach-resolution time.
  const paneAlive = (tabId: number, paneId: PaneId): boolean => {
    const tab = stateRef.current.tabs.find((t) => t.tabId === tabId);
    return tab !== undefined && tab.panes[paneId] !== undefined;
  };

  // This pane's onReady, cached so its identity never changes across App re-renders (keep-alive:
  // TerminalView's effect must not re-run on a tab switch or a sibling re-layout). It wires the
  // mounted terminal to a live session; if the pane/tab died while open_pty was in flight (OR a
  // StrictMode remount superseded this mount's epoch), the resolved session is an ORPHAN — dispose
  // it. A freshly-mounted pane that IS the active tab's focused pane grabs the keyboard (so a split
  // focuses its new pane the moment it mounts).
  const readyFor = (tabId: number, paneId: PaneId): ((handle: TerminalHandle) => void) => {
    let cb = paneOf(paneId).onReady;
    if (!cb) {
      cb = (handle) => {
        setPaneField(paneId, "handle", handle);
        const s = stateRef.current;
        const activeTab = s.tabs.find((t) => t.tabId === s.activeTabId);
        if (
          activeTab &&
          activeTab.focusedPaneId === paneId &&
          renamingRef.current === null &&
          badgingRef.current === null &&
          !openSearchRef.current.has(paneId) // trmx-98: an open find bar owns the keyboard
        ) {
          (handle.terminal as unknown as { focus?: () => void } | undefined)?.focus?.();
        }
        const epoch = (runtimesRef.current.get(paneId)?.attachEpoch ?? 0) + 1;
        setPaneField(paneId, "attachEpoch", epoch);
        seamsRef.current
          .attach(handle, { cwd: runtimesRef.current.get(paneId)?.pendingCwd })
          .then((info) => {
            const epochCurrent = runtimesRef.current.get(paneId)?.attachEpoch === epoch;
            if (paneAlive(tabId, paneId) && epochCurrent) {
              setPaneField(paneId, "sessionId", info.sessionId);
              dispatch({ kind: "attachSession", tabId, paneId, sessionId: info.sessionId, title: info.title });
              // trmx-93 (FR-5): if a script is pending for this pane (a picker run, or the startup
              // script), source it now that the session is live. Consumed ONLY on the current epoch so
              // a superseded StrictMode attach can't steal it; awaits the stored promise (startup's
              // async resolution), then sends `source '<abs>'` + CR through the sendInput seam.
              const pendingScript = runtimesRef.current.get(paneId)?.pendingScript;
              if (pendingScript) {
                setPaneField(paneId, "pendingScript", undefined);
                void pendingScript.then((resolved) => {
                  if (resolved && paneAlive(tabId, paneId)) {
                    seamsRef.current.sendInput(info.sessionId, `${resolved.sourceLine}\r`).catch(
                      (err: unknown) => {
                        log.error("sourcing the script failed", err);
                      },
                    );
                  }
                });
              }
            } else {
              // ORPHAN GUARD: the pane/tab closed mid-attach, OR this is a superseded (StrictMode)
              // mount — kill the session it will never show.
              seamsRef.current.closeSession(info.sessionId).catch((err: unknown) => {
                log.error("orphan session close failed", err);
              });
              // trmx-93: if the pane is truly DEAD (not merely a stale epoch on a still-live pane),
              // drop its pending script — no later attach will consume it. A stale-epoch-but-alive
              // pane keeps it so the current-epoch attach still sources it.
              if (!paneAlive(tabId, paneId)) setPaneField(paneId, "pendingScript", undefined);
            }
          })
          .catch((err: unknown) => {
            // Open failed (no backend in `pnpm dev`, or a real spawn error).
            log.error("pane attach failed", err);
            setPaneField(paneId, "pendingScript", undefined); // trmx-93: no session → the script never sources
            // trmx-237 (grill H4): the pane used to keep its placeholder title with a dead session and
            // say NOTHING — keystrokes went nowhere and nothing explained why. Write the reason into the
            // terminal the user is looking at. The SAME epoch + liveness guard as the success path above:
            // without it a superseded StrictMode rejection could scribble an error into a pane whose
            // later attach succeeded.
            const epochCurrent = runtimesRef.current.get(paneId)?.attachEpoch === epoch;
            if (!paneAlive(tabId, paneId) || !epochCurrent) return;
            writePaneNotice(handle, `could not start a shell: ${formatAttachError(err)}`);
          });
      };
      paneOf(paneId).onReady = cb;
    }
    return cb;
  };

  // This pane's onOscTitle, cached like `readyFor`. A program's OSC 0/2 title lands in the pane's
  // `osc` slot; the EMPTY string is the escape's reset (printf '\e]2;\a') and clears the slot.
  const oscTitleFor = (tabId: number, paneId: PaneId): ((title: string) => void) => {
    let cb = paneOf(paneId).onOscTitle;
    if (!cb) {
      cb = (title) => {
        dispatch({
          kind: "setTitleSource",
          tabId,
          paneId,
          source: "osc",
          value: title === "" ? null : title,
        });
      };
      paneOf(paneId).onOscTitle = cb;
    }
    return cb;
  };

  // trmx-90: this pane's onBadge, cached like readyFor/oscTitleFor (a stable identity — an inline
  // arrow would remount the terminal via TerminalView's effect deps). An OSC 1337 SetBadgeFormat
  // lands in THIS pane's `badge` slot (last-write-wins); null (empty/undecodable/cleared) removes it.
  // The per-pane closure is the load-bearing SCOPING — a `printf` in a BACKGROUND pane badges that
  // pane, never the focused one (the badge is orthogonal to the tab label by construction).
  const badgeFor = (tabId: number, paneId: PaneId): ((badge: string | null) => void) => {
    let cb = paneOf(paneId).onBadge;
    if (!cb) {
      cb = (badge) => {
        dispatch({ kind: "setBadge", tabId, paneId, badge });
      };
      paneOf(paneId).onBadge = cb;
    }
    return cb;
  };

  // trmx-91: apply ONE activity transition for a pane — persist the new debounce phase, (re)arm its
  // single timer to the returned deadline (clearing any prior), and dispatch the resolved visibility.
  // Shared by the session:activity event AND the timer's own fire, so both go through one arm+dispatch
  // path. The timer fire re-reads the pane's CURRENT phase (a stale fire is inert per onDeadline) and
  // recurses here. `tabId` is captured at arm time (a pane never migrates tabs); if the pane died
  // meanwhile the setActivity reducer no-ops on the unknown id, and disposePaneResources cleared the
  // timer, so a fire into a dead pane can't happen anyway.

  // E15's body, verbatim. The root keeps the useEffect and its dependency array; only the work moves.
  const focusFocusedPane = (activeFocusedPaneId: PaneId | null) => {
    if (renamingRef.current !== null || badgingRef.current !== null) return;
    if (activeFocusedPaneId === null) return;
    if (openSearchRef.current.has(activeFocusedPaneId)) return;
    const terminal = runtimesRef.current.get(activeFocusedPaneId)?.handle?.terminal;
    (terminal as unknown as { focus?: () => void } | undefined)?.focus?.();
  };

  return { storeFor, readyFor, oscTitleFor, badgeFor, focusFocusedPane };
}
