// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: the command concern — the CommandContext every verb routes through, plus the bodies of
// E02 (keymap rebuild) and E14 (the DOM keydown gate). Pure logic: no state, no refs, no effects.
//
// `commandCtxRef`, `keymapRef`, `dispatcherRef` and `commandsRef` stay ROOT-owned. That is not
// tidiness: `dispatcherRef.current` is a singleton Dispatcher closing over a forwarding Proxy that
// reads `commandCtxRef.current`, and the root reassigns that ref DURING render. Rebuilding the
// dispatcher per render, or handing bridges a memoised commandCtx instead of the ref, breaks E05,
// E10 and E14 silently — they read it out-of-render and would see stale state.

import type { Dispatch, SetStateAction } from "react";
import { growTarget } from "../commands/growPane";
import {
  describeTarget,
  FULL_DEFAULT_KEYS,
  mergeKeymap,
  resolve as resolveKeymap,
} from "../commands/keymapDispatch";
import { onKeysChanged, readKeys } from "../commands/keysBackend";
import type { CommandContext } from "../commands/registry";
import { log } from "../ipc/logSink";
import {
  initialActivity,
  lightActive,
  onManualToggle,
  type ActivityTransition,
} from "../panes/activityLine";
import {
  MIN_PANE_PX,
  setRatio as setRatioTree,
  solveRects,
  type PaneId,
  type Rect,
} from "../panes/layoutTree";

import { makeSettingsStore } from "../store/settingsStore";

import { tabPaneIds, type Tab, type TabsAction, type TabsState } from "../tabs/tabState";
import type { Direction as NavDirection } from "../panes/paneNav";
import type { CloseOpts, PendingClose } from "./closeContracts";
import type { PaneRuntimes } from "./paneRuntime";

export type CommandSeams = {
  closeWindow: () => void;
  quitConfirmed: () => void;
  sendInput: (sessionId: number, data: string) => Promise<void>;
};

export type CommandContextDeps = {
  runtimesRef: { current: PaneRuntimes };
  stateRef: { current: TabsState };
  seamsRef: { current: CommandSeams };
  boundsRef: { current: Rect };
  pendingCloseRef: { current: PendingClose | null };
  keymapRef: { current: Record<string, string> };
  dispatcherRef: { current: { dispatch: (id: string) => void } | null };
  dispatch: Dispatch<TabsAction>;
  getActiveTab: () => Tab | undefined;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  flashingPanes: Set<PaneId>;
  setKeymap: Dispatch<SetStateAction<Record<string, string>>>;
  setRenamingTabId: Dispatch<SetStateAction<number | null>>;
  setBadgingPaneId: Dispatch<SetStateAction<PaneId | null>>;
  setOpenSearchPanes: Dispatch<SetStateAction<Set<PaneId>>>;
  setScriptPickerRequest: Dispatch<SetStateAction<"tab" | "right" | "below" | null>>;
  setShowPalette: Dispatch<SetStateAction<boolean>>;
  close: { closeTabInternal: (tabId: number, opts?: CloseOpts) => void };
  activity: {
    applyActivityTransition: (tabId: number, paneId: PaneId, t: ActivityTransition) => void;
    clearFlashFor: (paneId: PaneId) => void;
  };
  paneOps: {
    requestNewTab: () => void;
    requestSplit: (dir: "right" | "below") => { paneId: number } | null;
    requestPaneNav: (
      action: { kind: "nav-dir"; dir: NavDirection } | { kind: "nav-cycle"; delta: 1 | -1 },
    ) => void;
    requestCloseActive: (origin?: "user" | "remote") => void;
  };
};

export type CommandContextOut = {
  commandCtx: CommandContext;
  /** E02's body — the keymap rebuild + keys:changed watcher. Returns its teardown. */
  rebuildKeymap: () => () => void;
  /** E14's body — the DOM keydown gate. Returns its teardown. */
  installKeyDown: () => () => void;
};

export function useCommandContext(deps: CommandContextDeps): CommandContextOut {
  const {
    runtimesRef, stateRef, seamsRef, boundsRef, pendingCloseRef, keymapRef, dispatcherRef,
    dispatch, getActiveTab, invoke, flashingPanes, setKeymap, setRenamingTabId, setBadgingPaneId,
    setOpenSearchPanes, setScriptPickerRequest, setShowPalette, close, activity, paneOps,
  } = deps;
  const { closeTabInternal } = close;
  const { applyActivityTransition, clearFlashFor } = activity;
  const { requestNewTab, requestSplit, requestPaneNav, requestCloseActive } = paneOps;

  const commandCtx: CommandContext = {
    newTab: requestNewTab,
    // trmx-94: tab.close closes the WHOLE active tab; pane.close (⌘W) closes the focused pane
    // (pane precedence — the last pane closing takes the tab). Distinct commands (review finding 4).
    closeActiveTab: (origin) => {
      const a = stateRef.current.activeTabId;
      if (a !== null) closeTabInternal(a, { origin: origin ?? "user" });
    },
    nextTab: () => dispatch({ kind: "nextTab" }),
    prevTab: () => dispatch({ kind: "prevTab" }),
    selectTab: (index) => dispatch({ kind: "selectIndex", index }),
    renameActiveTab: () => {
      const a = stateRef.current.activeTabId;
      if (a !== null) setRenamingTabId(a);
    },
    newTabWithScript: () => setScriptPickerRequest("tab"),
    splitRight: () => requestSplit("right"),
    splitBelow: () => requestSplit("below"),
    splitRightWithScript: () => setScriptPickerRequest("right"),
    splitBelowWithScript: () => setScriptPickerRequest("below"),
    closePane: requestCloseActive,
    focusPane: (dir) => requestPaneNav({ kind: "nav-dir", dir }),
    nextPane: () => requestPaneNav({ kind: "nav-cycle", delta: 1 }),
    prevPane: () => requestPaneNav({ kind: "nav-cycle", delta: -1 }),
    setBadge: () => {
      const tab = getActiveTab();
      if (tab) setBadgingPaneId(tab.focusedPaneId);
    },
    toggleActivity: () => {
      // trmx-191: the ⌘⇧A one-shot override on the FOCUSED pane. The direction derives from the
      // RENDERED state — lightActive OR the trmx-99 flash, the exact disjunction the overlay draws
      // from — so a flash-only stuck bar forces OFF (and its flash clears) instead of stacking a
      // force-on under it. The setActivity dispatch inside applyActivityTransition flips
      // activityVisible, so the trmx-190 counter numerator moves in the same interaction (the
      // shared invariant), with zero counter wiring here.
      const tab = getActiveTab();
      if (!tab) return;
      const paneId = tab.focusedPaneId;
      const now = Date.now();
      const current = runtimesRef.current.get(paneId)?.activity ?? initialActivity();
      const renderedActive = lightActive(current, now) || flashingPanes.has(paneId);
      if (renderedActive) clearFlashFor(paneId);
      applyActivityTransition(
        tab.tabId,
        paneId,
        onManualToggle(current, renderedActive ? "off" : "on", now),
      );
    },
    growPane: (dir) => {
      const tab = getActiveTab();
      if (!tab) return;
      const target = growTarget(tab.tree, tab.focusedPaneId, dir);
      if (!target) return;
      // trmx-94 (review finding 6): reject a grow that would push a sibling below MIN_PANE_PX — the
      // same pixel floor the divider drag enforces (the reducer only clamps the numeric MIN_RATIO).
      const solved = solveRects(setRatioTree(tab.tree, target.path, target.ratio), boundsRef.current);
      const tooSmall = solved.panes.some(
        (pane) => pane.rect.width < MIN_PANE_PX.width || pane.rect.height < MIN_PANE_PX.height,
      );
      if (tooSmall) return;
      dispatch({ kind: "setPaneRatio", tabId: tab.tabId, path: target.path, ratio: target.ratio });
    },
    movePane: (dir) => {
      // trmx-100 (FR-3.4): re-dock the focused pane onto its neighbor's far edge in `dir` (a flip). The
      // reducer no-ops when there is no neighbor / the result is structurally identical.
      const tab = getActiveTab();
      if (!tab) return;
      dispatch({
        kind: "movePaneDir",
        tabId: tab.tabId,
        paneId: tab.focusedPaneId,
        dir,
        bounds: boundsRef.current,
      });
    },
    clearScrollback: () => {
      const tab = getActiveTab();
      if (!tab) return;
      const handle = runtimesRef.current.get(tab.focusedPaneId)?.handle;
      (handle?.terminal as unknown as { clear?: () => void } | undefined)?.clear?.();
    },
    // trmx-98 (FR-1.5): open the focused pane's find bar (or focus it if already open). The bar renders
    // as a pane-host child and registers its controller into searchControllersRef on mount.
    openSearch: () => {
      const tab = getActiveTab();
      if (!tab) return;
      const paneId = tab.focusedPaneId;
      const controller = runtimesRef.current.get(paneId)?.search;
      if (controller) controller.focus();
      else setOpenSearchPanes((prev) => new Set(prev).add(paneId));
    },
    searchNext: () => {
      const tab = getActiveTab();
      if (tab) runtimesRef.current.get(tab.focusedPaneId)?.search?.next();
    },
    searchPrev: () => {
      const tab = getActiveTab();
      if (tab) runtimesRef.current.get(tab.focusedPaneId)?.search?.prev();
    },
    closeSearch: () => {
      const tab = getActiveTab();
      if (tab) runtimesRef.current.get(tab.focusedPaneId)?.search?.close();
    },
    openSettings: () => {
      invoke("open_settings_window", { section: null }).catch((err: unknown) =>
        log.error("open settings failed", err),
      );
    },
    checkForUpdates: () => {
      invoke("open_settings_window", { section: "about" }).catch((err: unknown) =>
        log.error("open settings (updates) failed", err),
      );
    },
    // trmx-144: a REMOTE window.close confirms the quit directly (never gates, never re-enters the
    // native close → close:requested loop); a user one takes the native path, which round-trips
    // through close:requested where the quit gate lives.
    closeWindow: (origin) => {
      if (origin === "remote") seamsRef.current.quitConfirmed();
      else seamsRef.current.closeWindow();
    },
    openCommandPalette: () => setShowPalette(true),
    selectTheme: (id) => makeSettingsStore().set("appearance.theme", id),
    runScript: (sourceLine) => {
      const tab = getActiveTab();
      const sessionId = tab ? runtimesRef.current.get(tab.focusedPaneId)?.sessionId : undefined;
      if (sessionId !== undefined) {
        seamsRef.current.sendInput(sessionId, `${sourceLine}\r`).catch((err: unknown) =>
          log.error("run script failed", err),
        );
      }
    },
    tabCount: () => stateRef.current.tabs.length,
    paneCount: () => {
      const tab = getActiveTab();
      return tab ? tabPaneIds(tab).length : 0;
    },
  };

  const rebuildKeymap = () => {
    let live = true;
    const rebuild = () => {
      readKeys(invoke).then((userKeys) => {
        if (live) setKeymap(mergeKeymap(FULL_DEFAULT_KEYS, Object.entries(userKeys)).keymap);
      });
    };
    rebuild();
    const teardown = onKeysChanged(rebuild);
    return () => {
      live = false;
      teardown();
    };
  };

  const installKeyDown = () => {
    const onKeyDown = (ev: KeyboardEvent) => {
      // trmx-144: while the confirm-close dialog is up it owns the keyboard — its own onKeyDown is
      // the only keyboard surface; no chord may dispatch under a modal question.
      if (pendingCloseRef.current !== null) return;
      // trmx-94 (FR-9.3): resolve the chord to a WEBVIEW-owned command via the effective keymap
      // (defaults ⊕ user [keys]); native-menu chords (⌘T/⌘W/…) and ⌘C/⌘V resolve null here. A
      // resolved command is fully owned by the app: preventDefault + stopImmediatePropagation so the
      // chord never leaks a byte to xterm / the PTY (the trmx-86 pane-nav discipline, now uniform).
      const commandId = resolveKeymap(ev, describeTarget(ev.target), keymapRef.current);
      if (!commandId) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      dispatcherRef.current?.dispatch(commandId);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  };

  return { commandCtx, rebuildKeymap, installKeyDown };
}
