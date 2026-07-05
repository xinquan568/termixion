// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-4/B-5: the app shell. On load it handshakes with the backend (core_version round-trip via
// useBackend) and renders the terminal surface. C-2/C-3 stream the live PTY into the terminal.
//
// trmx-35: the terminal owns the whole window — no in-page chrome, flush to every edge (index.css).
// trmx-51: Settings lives in its own window (main.tsx's surface routing); the main window mounts
// the headless UpdateAuthorityHost — automatic update checks + serving the settings window.
//
// trmx-74/75/81/82: App is the TAB MANAGER — a `useReducer` shell over the pure tab model.
// trmx-84 (FR-3.1/3.2): App is now also the PANE MANAGER. A tab owns a pure layout TREE
// (panes/layoutTree.ts) of one-or-more panes; App renders each leaf as an ABSOLUTELY-POSITIONED,
// paneId-keyed SIBLING div styled from `solveRects` — never nested DOM. A split/close/resize only
// mutates `style.left/top/width/height` on stable keyed hosts, so xterm's canvases and the running
// PTY are NEVER reparented or remounted ("move, don't recreate"). All the trmx-74/75 per-surface
// plumbing (cwd store, terminal handle, session id, attach epoch, onReady/onOscTitle callbacks,
// title mirror) moves from tabId keying to **paneId** keying — a pane is exactly what a tab's single
// surface was. Pane ids are global + monotonic so those maps never alias across tabs.
// - KEEP-ALIVE: every pane host stays mounted (keyed by the never-reused paneId); an inactive tab
//   host is display:none; a terminal unmounts ONLY when its PANE closes. Pane ORDER always comes
//   from the tree (solveRects/leaves), never Object.keys(panes).
// - Creation (⌘D / ⇧⌘D or the split-right/split-below menu verbs): the new pane inherits the FOCUSED
//   pane's OSC-7 cwd, takes focus; a split that can't fit the min pane size is a soft no-op.
// - Closing (⌘W): pane → tab → window. Close the focused pane (close_pty); if it was the last pane
//   the tab closes; if the last tab, the window. A pane's `pty:exited` closes just that pane. The
//   tab-strip × closes the WHOLE tab (loops close_pty over its panes — no core bulk-close).
// - Titles (trmx-75, now per pane): the tab label + native window title follow the ACTIVE tab's
//   FOCUSED pane title; a background pane's OSC/hint updates its own state only. Rename targets the
//   focused pane's manual title.
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TerminalView, type SettingsObservation } from "./terminal/TerminalView";
import { TabStrip } from "./tabs/TabStrip";
import { barLayoutFor, labelOrientationFor } from "./tabs/barLayout";
import {
  canSplitFocused,
  initialTabsState,
  paneBySessionId,
  reduceTabs,
  tabPaneIds,
} from "./tabs/tabState";
import {
  MIN_PANE_PX,
  solveRects,
  type DividerRect,
  type PaneId,
  type Rect,
  type SplitDir,
} from "./panes/layoutTree";
import { grabOffsetOf, ratioForDrag, RESET_RATIO } from "./panes/dividerDrag";
import { nextPane, paneInDirection, type Direction } from "./panes/paneNav";
import { activeDividerKeys, dividerKey } from "./panes/paneChrome";
import { type FrameSchedule } from "./terminal/resizeCoalescer";
import {
  isLabelOrientation,
  isTabBarPosition,
  makeSettingsStore,
  SETTINGS_CHANGED_EVENT,
  type LabelOrientation,
  type TabBarPosition,
} from "./settings/settingsStore";
import { describeTarget, tabKeyAction } from "./tabs/tabKeymap";
import { useBackend } from "./ipc/useBackend";
import {
  closePty,
  onPtyExited,
  onTitleHint,
  setSessionTitle,
  type SessionInfo,
} from "./ipc/backend";
import { realEventBus } from "./ipc/eventBus";
import { makeCwdStore, type CwdStore } from "./terminal/osc7";
import { realSetWindowTitle } from "./terminal/windowTitle";
import type { TerminalHandle } from "./terminal/mountTerminal";
import { UpdateAuthorityHost } from "./update/UpdateAuthorityHost";

/** The menu's tab-intent broadcast (main.rs emits "new"/"close"/"next"/"prev"/split verbs). */
export const TABS_ACTION_EVENT = "tabs:action";

// trmx-85: the drag rAF schedule (one setPaneRatio per frame, the trmx-67 coalescer idiom). A
// module-level const — NOT an inline arrow — and injectable via AppProps for deterministic tests.
const realFrameSchedule: FrameSchedule = (cb) => {
  if (typeof requestAnimationFrame === "undefined") {
    const t = setTimeout(cb, 16);
    return () => clearTimeout(t);
  }
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
};

/** The default content bounds before the real ResizeObserver measures the pane area (px). */
const DEFAULT_BOUNDS: Rect = { x: 0, y: 0, width: 800, height: 600 };

/** Wire a mounted terminal to a live PTY session; resolves the session's identity (useBackend). */
export type AttachFn = (
  handle: TerminalHandle,
  opts?: { cwd?: string },
) => Promise<SessionInfo>;

/** Observe the menu's `tabs:action` broadcasts; returns a teardown. */
export type TabsActionObservation = (onAction: (payload: unknown) => void) => () => void;

/** Observe `pty:exited` sessionIds; returns a teardown. */
export type PtyExitedObservation = (onExit: (sessionId: number) => void) => () => void;

/** Observe `session:title-hint` broadcasts (trmx-75); returns a teardown. */
export type TitleHintObservation = (
  onHint: (sessionId: number, name: string) => void,
) => () => void;

/**
 * The production last-tab-close sink: close the native window. Lazy-imported and error-swallowed
 * like realSetWindowTitle (windowTitle.ts) — without a Tauri runtime (`pnpm dev`, jsdom) there is
 * no window to close and that must stay inert. No per-session cleanup here: the backend's
 * CloseRequested handler kill_all's every session (trmx-74).
 */
export function realCloseWindow(): void {
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().close())
    .catch(() => {
      // No Tauri runtime — a plain browser tab owns its own lifecycle.
    });
}

// Observe the menu's tabs:action broadcasts over the event bus, with the teardown-before-resolve
// pattern from TerminalView's realObserveSettings: a teardown called before the async listen
// resolves unlistens the late subscription instead of leaking it, and the `live` guard keeps a
// torn-down handler silent. In a plain browser/jsdom the listen rejects and the seam is inert.
const realObserveTabsAction: TabsActionObservation = (onAction) => {
  let live = true;
  let unlisten: (() => void) | undefined;
  realEventBus
    .listen(TABS_ACTION_EVENT, (payload) => {
      if (live) onAction(payload);
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — there is no menu to announce tab intents.
    });
  return () => {
    live = false;
    unlisten?.();
  };
};

// trmx-81: observe settings:changed for the tab-bar position — the same teardown-before-resolve
// pattern as realObserveTabsAction above (TerminalView's realObserveSettings). A module-level
// const, NOT an inline arrow: it is an effect dep, and a fresh identity every render would
// re-subscribe on every App re-render.
const realObserveAppSettings: SettingsObservation = (onChange) => {
  let live = true;
  let unlisten: (() => void) | undefined;
  realEventBus
    .listen(SETTINGS_CHANGED_EVENT, (payload) => {
      if (live) onChange(payload);
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — the bar stays where hydration seeded it for this session.
    });
  return () => {
    live = false;
    unlisten?.();
  };
};

export interface AppProps {
  /** Injection seam for tests; defaults to useBackend's attachTerminal (the live PTY wiring). */
  attach?: AttachFn;
  /** Injection seam for tests; defaults to closing the native window (last-tab close). */
  closeWindow?: () => void;
  /** Injection seam for tests; defaults to the real `close_pty` command. */
  closeSession?: (sessionId: number) => Promise<void>;
  /** Injection seam for tests; defaults to the real `tabs:action` event-bus subscription. */
  observeTabsAction?: TabsActionObservation;
  /** Injection seam for tests; defaults to the real `pty:exited` event-bus subscription. */
  observePtyExited?: PtyExitedObservation;
  /** Injection seam for tests; defaults to the real `session:title-hint` subscription (trmx-75). */
  observeTitleHint?: TitleHintObservation;
  /** Injection seam for tests; defaults to the real `settings:changed` subscription (trmx-81). */
  observeSettings?: SettingsObservation;
  /** Injection seam for tests; defaults to retitling the native window (trmx-75). */
  setWindowTitle?: (title: string) => void;
  /** Injection seam for tests; defaults to the real `set_session_title` core mirror (trmx-75). */
  mirrorTitle?: (sessionId: number, title: string) => Promise<void>;
  /** Injection seam for tests; the frame schedule that throttles divider-drag dispatches (trmx-85). */
  dragSchedule?: FrameSchedule;
}

export function App({
  attach,
  closeWindow = realCloseWindow,
  closeSession = closePty,
  observeTabsAction = realObserveTabsAction,
  observePtyExited = onPtyExited,
  observeTitleHint = onTitleHint,
  observeSettings = realObserveAppSettings,
  setWindowTitle = realSetWindowTitle,
  mirrorTitle = setSessionTitle,
  dragSchedule = realFrameSchedule,
}: AppProps = {}) {
  const { attachTerminal } = useBackend();
  const attachFn = attach ?? attachTerminal;

  const [state, dispatch] = useReducer(reduceTabs, undefined, initialTabsState);
  // trmx-75: the tab whose label is an inline rename input (null = not renaming). Rename targets
  // that tab's FOCUSED pane's manual title. While non-null, focus-follows-activation is suppressed.
  const [renamingTabId, setRenamingTabId] = useState<number | null>(null);
  // trmx-81/82: the tab bar's window edge + side-label orientation, seeded from the shared settings
  // snapshot (hydrated before mount), kept live over settings:changed.
  const [barPosition, setBarPosition] = useState<TabBarPosition>(() =>
    makeSettingsStore().get("tabs.barPosition"),
  );
  const [sideLabelOrientation, setSideLabelOrientation] = useState<LabelOrientation>(() =>
    makeSettingsStore().get("tabs.sideLabelOrientation"),
  );
  // trmx-84: the measured pane content area — `solveRects` bounds. Seeded to a usable default so a
  // headless render (jsdom, pre-layout) still lays panes out; the ResizeObserver below refreshes it
  // once the window has a real size (a 0×0 reading is ignored so it never clobbers the default).
  const [bounds, setBounds] = useState<Rect>(DEFAULT_BOUNDS);

  // Mirror of the reducer state for callbacks that fire OUTSIDE the render cycle (attach
  // resolutions, event subscriptions) — kept current by the effect below.
  const stateRef = useRef(state);
  // trmx-84: per-PANE plumbing, all keyed by the never-reused, GLOBAL paneId:
  const contentRef = useRef<HTMLDivElement | null>(null); // the measured pane content area
  const boundsRef = useRef(bounds); // latest bounds for out-of-render split guards
  const storesRef = useRef(new Map<PaneId, CwdStore>()); // OSC 7 cwd, one store per pane
  const handlesRef = useRef(new Map<PaneId, TerminalHandle>()); // mounted terminals
  const sessionsRef = useRef(new Map<PaneId, number>()); // attached backend sessionIds
  const pendingCwdRef = useRef(new Map<PaneId, string | undefined>()); // cwd to seed the open with
  const readyCbsRef = useRef(new Map<PaneId, (handle: TerminalHandle) => void>()); // stable onReady per pane
  const oscTitleCbsRef = useRef(new Map<PaneId, (title: string) => void>()); // stable onOscTitle per pane
  const mirroredRef = useRef(new Map<PaneId, string>()); // last title mirrored to the core, per pane
  // Attach epoch per pane: each onReady bumps it; a resolution whose epoch is no longer current is
  // STALE (StrictMode's dev remount opens two PTYs — only the current epoch keeps its session).
  const attachEpochRef = useRef(new Map<PaneId, number>());
  const renamingRef = useRef(renamingTabId); // out-of-render read for the onReady focus guard
  const bootedRef = useRef(false);

  // Latest-seam ref: the cached per-pane callbacks (stable identity — an inline arrow would remount
  // the terminal via TerminalView's effect deps) read the CURRENT seams through it.
  const seamsRef = useRef({ attach: attachFn, closeWindow, closeSession, setWindowTitle, mirrorTitle });
  seamsRef.current = { attach: attachFn, closeWindow, closeSession, setWindowTitle, mirrorTitle };
  boundsRef.current = bounds;
  renamingRef.current = renamingTabId;

  // Keep stateRef pointed at the latest COMMITTED state for the out-of-render callbacks (attach
  // resolutions, event subscriptions) — an effect, not a render assignment, so a discarded render
  // never leaves it pointing at uncommitted state (the trmx-74 pattern).
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Boot: exactly ONE initial tab (one pane). The ref guards StrictMode's double effect-invocation.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (stateRef.current.tabs.length === 0) dispatch({ kind: "openTab" });
  }, []);

  // trmx-84: measure the pane content area for solveRects. Guarded for jsdom (no ResizeObserver) and
  // 0×0 readings, so tests keep the usable default bounds and real runtime tracks the window size.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        setBounds({ x: 0, y: 0, width: Math.round(r.width), height: Math.round(r.height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // This pane's cwd store, created lazily at RENDER time — so it exists from the terminal's mount
  // and an OSC 7 report (or a cwd-inheritance capture) can land before the session attaches.
  const storeFor = (paneId: PaneId): CwdStore => {
    let store = storesRef.current.get(paneId);
    if (!store) {
      store = makeCwdStore();
      storesRef.current.set(paneId, store);
    }
    return store;
  };

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
    let cb = readyCbsRef.current.get(paneId);
    if (!cb) {
      cb = (handle) => {
        handlesRef.current.set(paneId, handle);
        const s = stateRef.current;
        const activeTab = s.tabs.find((t) => t.tabId === s.activeTabId);
        if (activeTab && activeTab.focusedPaneId === paneId && renamingRef.current === null) {
          (handle.terminal as unknown as { focus?: () => void } | undefined)?.focus?.();
        }
        const epoch = (attachEpochRef.current.get(paneId) ?? 0) + 1;
        attachEpochRef.current.set(paneId, epoch);
        seamsRef.current
          .attach(handle, { cwd: pendingCwdRef.current.get(paneId) })
          .then((info) => {
            const epochCurrent = attachEpochRef.current.get(paneId) === epoch;
            if (paneAlive(tabId, paneId) && epochCurrent) {
              sessionsRef.current.set(paneId, info.sessionId);
              dispatch({ kind: "attachSession", tabId, paneId, sessionId: info.sessionId, title: info.title });
            } else {
              // ORPHAN GUARD: the pane/tab closed mid-attach, OR this is a superseded (StrictMode)
              // mount — kill the session it will never show.
              seamsRef.current.closeSession(info.sessionId).catch((err: unknown) => {
                console.error("[termixion] orphan session close failed", err);
              });
            }
          })
          .catch((err: unknown) => {
            // Open failed (no backend in `pnpm dev`, or a real spawn error): the pane keeps its
            // placeholder title with a dead session — do not crash the shell.
            console.error("[termixion] pane attach failed", err);
          });
      };
      readyCbsRef.current.set(paneId, cb);
    }
    return cb;
  };

  // This pane's onOscTitle, cached like `readyFor`. A program's OSC 0/2 title lands in the pane's
  // `osc` slot; the EMPTY string is the escape's reset (printf '\e]2;\a') and clears the slot.
  const oscTitleFor = (tabId: number, paneId: PaneId): ((title: string) => void) => {
    let cb = oscTitleCbsRef.current.get(paneId);
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
      oscTitleCbsRef.current.set(paneId, cb);
    }
    return cb;
  };

  // Dispose one pane's resources: drop all its paneId-keyed maps and close its PTY (unless the
  // shell already exited). Shared by pane-close, pty:exited, and whole-tab close — one path, no leak.
  const disposePaneResources = (paneId: PaneId, opts?: { alreadyExited?: boolean }) => {
    const sessionId = sessionsRef.current.get(paneId);
    sessionsRef.current.delete(paneId);
    handlesRef.current.delete(paneId);
    storesRef.current.delete(paneId);
    pendingCwdRef.current.delete(paneId);
    readyCbsRef.current.delete(paneId);
    oscTitleCbsRef.current.delete(paneId);
    mirroredRef.current.delete(paneId);
    attachEpochRef.current.delete(paneId);
    if (sessionId !== undefined && !opts?.alreadyExited) {
      seamsRef.current.closeSession(sessionId).catch((err: unknown) => {
        console.error("[termixion] close pty failed", err);
      });
    }
  };

  // Close a whole tab (all its panes) — the tab-strip × and the last-pane fallthrough. The LAST tab
  // closes the WINDOW instead (no dispatch, no per-session close — the backend's CloseRequested
  // kill_all owns cleanup). Otherwise drop the tab and dispose every pane's resources.
  const closeTabInternal = (tabId: number, opts?: { alreadyExited?: boolean }) => {
    const s = stateRef.current;
    const tab = s.tabs.find((t) => t.tabId === tabId);
    if (!tab) return;
    if (s.tabs.length <= 1) {
      seamsRef.current.closeWindow();
      return;
    }
    const paneIds = tabPaneIds(tab);
    dispatch({ kind: "closeTab", tabId });
    for (const paneId of paneIds) disposePaneResources(paneId, opts);
    // A tab dying MID-RENAME must clear the rename state, or a stuck renamingTabId would suppress
    // focus-follows-activation forever.
    setRenamingTabId((current) => (current === tabId ? null : current));
  };

  // Close one pane with the ⌘W precedence: pane → tab → window. More than one pane → drop just that
  // pane (its sibling re-lays out, sessions untouched). The LAST pane of a tab closes the whole tab
  // (which may be the last tab → the window).
  const closePaneInternal = (tabId: number, paneId: PaneId, opts?: { alreadyExited?: boolean }) => {
    const s = stateRef.current;
    const tab = s.tabs.find((t) => t.tabId === tabId);
    if (!tab || tab.panes[paneId] === undefined) return;
    if (tabPaneIds(tab).length > 1) {
      // A pane dying mid-rename (it is the focused/renamed pane) must clear the rename, or the input
      // would survive and re-target the NEW focused pane on commit. The whole-tab branch clears it
      // in closeTabInternal; the pane branch must do the same for the focused pane.
      const wasRenamedPane = tab.focusedPaneId === paneId;
      dispatch({ kind: "closePane", tabId, paneId });
      disposePaneResources(paneId, opts);
      if (wasRenamedPane) setRenamingTabId((current) => (current === tabId ? null : current));
    } else {
      closeTabInternal(tabId, opts);
    }
  };

  // Open a new tab inheriting the ACTIVE tab's FOCUSED pane cwd: capture it NOW, keyed by the pane
  // id the reducer WILL allocate for the new tab's single pane (nextPaneId).
  const requestNewTab = () => {
    const s = stateRef.current;
    const upcomingPaneId = s.nextPaneId;
    const activeTab =
      s.activeTabId !== null ? s.tabs.find((t) => t.tabId === s.activeTabId) : undefined;
    const activeStore = activeTab ? storesRef.current.get(activeTab.focusedPaneId) : undefined;
    pendingCwdRef.current.set(upcomingPaneId, activeStore?.get() ?? undefined);
    dispatch({ kind: "openTab" });
  };

  // trmx-84: split the active tab's focused pane. `right` → a row split (side by side), `below` → a
  // column split (stacked). Refused (soft no-op) when the result would go below the min pane size.
  // The new pane inherits the focused pane's cwd and takes focus (readyFor focuses it on mount).
  const requestSplit = (dir: "right" | "below") => {
    const s = stateRef.current;
    if (s.activeTabId === null) return;
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId);
    if (!tab) return;
    const treeDir: SplitDir = dir === "right" ? "row" : "column";
    if (!canSplitFocused(tab, treeDir, boundsRef.current, MIN_PANE_PX)) return; // won't fit — no-op
    const upcomingPaneId = s.nextPaneId;
    const focusedStore = storesRef.current.get(tab.focusedPaneId);
    pendingCwdRef.current.set(upcomingPaneId, focusedStore?.get() ?? undefined);
    dispatch({ kind: "splitPane", tabId: tab.tabId, dir: treeDir });
  };

  // trmx-86 (FR-3.5): move focus between panes of the ACTIVE tab. `nav-dir` picks the geometrically
  // nearest pane via paneInDirection over the current solved rects; `nav-cycle` steps the leaves order.
  // A null / same-as-current target is a no-op. Shared by the keymap AND the Window-menu verbs, and kept
  // action-shaped so FR-9's command registry can lift it directly.
  const requestPaneNav = (
    action: { kind: "nav-dir"; dir: Direction } | { kind: "nav-cycle"; delta: 1 | -1 },
  ) => {
    const s = stateRef.current;
    if (s.activeTabId === null) return;
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId);
    if (!tab) return;
    const target =
      action.kind === "nav-dir"
        ? paneInDirection(solveRects(tab.tree, boundsRef.current).panes, tab.focusedPaneId, action.dir)
        : nextPane(tab.tree, tab.focusedPaneId, action.delta);
    if (target !== null && target !== tab.focusedPaneId) {
      dispatch({ kind: "focusPane", tabId: tab.tabId, paneId: target });
    }
  };

  // ⌘W / menu "close": close the active tab's FOCUSED pane (pane → tab → window).
  const requestCloseActive = () => {
    const s = stateRef.current;
    if (s.activeTabId === null) return;
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId);
    if (!tab) return;
    closePaneInternal(tab.tabId, tab.focusedPaneId);
  };

  // The tab-strip × closes the WHOLE tab (all its panes), distinct from the ⌘W pane precedence.
  const requestCloseTab = (tabId: number) => closeTabInternal(tabId);

  // trmx-75: the rename intents. Start = activate + flip into rename; commit writes the FOCUSED
  // pane's manual title (empty → clear-to-auto); cancel drops the edit. Commit/cancel clearing
  // `renamingTabId` re-runs the focus effect, handing the keyboard back to the focused pane.
  const startRename = (tabId: number) => {
    dispatch({ kind: "activateTab", tabId });
    setRenamingTabId(tabId);
  };
  const commitRename = (tabId: number, value: string) => {
    const tab = stateRef.current.tabs.find((t) => t.tabId === tabId);
    if (tab) {
      dispatch({
        kind: "setTitleSource",
        tabId,
        paneId: tab.focusedPaneId,
        source: "manual",
        value: value.trim() === "" ? null : value,
      });
    }
    setRenamingTabId(null);
  };
  const cancelRename = () => setRenamingTabId(null);

  // Subscriptions: pty:exited (a pane's shell exited → close just that pane), session:title-hint
  // (route by sessionId into the owning PANE's `process` slot), and the menu's tabs:action intents.
  useEffect(() => {
    const stopExited = observePtyExited((sessionId) => {
      const hit = paneBySessionId(stateRef.current, sessionId);
      if (hit) closePaneInternal(hit.tab.tabId, hit.paneId, { alreadyExited: true });
    });
    const stopTitleHints = observeTitleHint((sessionId, name) => {
      const hit = paneBySessionId(stateRef.current, sessionId);
      if (hit) {
        dispatch({
          kind: "setTitleSource",
          tabId: hit.tab.tabId,
          paneId: hit.paneId,
          source: "process",
          value: name,
        });
      }
    });
    const stopTabsAction = observeTabsAction((payload) => {
      // Events are untrusted input: only the exact verb strings act; junk is inert.
      if (payload === "new") requestNewTab();
      else if (payload === "close") requestCloseActive();
      else if (payload === "next") dispatch({ kind: "nextTab" });
      else if (payload === "prev") dispatch({ kind: "prevTab" });
      else if (payload === "split-right") requestSplit("right");
      else if (payload === "split-below") requestSplit("below");
      // trmx-86: Window ▸ Select Pane / Next/Previous Pane verbs → the same pane-nav path as the keymap.
      else if (payload === "pane-left") requestPaneNav({ kind: "nav-dir", dir: "left" });
      else if (payload === "pane-right") requestPaneNav({ kind: "nav-dir", dir: "right" });
      else if (payload === "pane-up") requestPaneNav({ kind: "nav-dir", dir: "up" });
      else if (payload === "pane-down") requestPaneNav({ kind: "nav-dir", dir: "down" });
      else if (payload === "pane-next") requestPaneNav({ kind: "nav-cycle", delta: 1 });
      else if (payload === "pane-prev") requestPaneNav({ kind: "nav-cycle", delta: -1 });
      else if (payload === "rename") {
        const active = stateRef.current.activeTabId;
        if (active !== null) setRenamingTabId(active);
      }
    });
    return () => {
      stopExited();
      stopTitleHints();
      stopTabsAction();
    };
  }, [observePtyExited, observeTitleHint, observeTabsAction]);

  // trmx-81/82: keep the bar position + side-label orientation live over settings:changed. Its OWN
  // effect, dep'd only on the stable observation seam — payloads are untrusted (only a well-formed
  // key with a registry-valid value updates state).
  useEffect(() => {
    const stopSettings = observeSettings((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const { key, value } = payload as { key?: unknown; value?: unknown };
      if (key === "tabs.barPosition" && isTabBarPosition(value)) setBarPosition(value);
      else if (key === "tabs.sideLabelOrientation" && isLabelOrientation(value)) {
        setSideLabelOrientation(value);
      }
    });
    return stopSettings;
  }, [observeSettings]);

  // ⌘1..⌘9 select a tab; ⌘D / ⇧⌘D split (trmx-84); ⌥⌘-arrows / ⌘]/⌘[ navigate panes (trmx-86). Capture
  // phase on window so the chord wins even while xterm's helper textarea has focus; tabKeymap vetoes
  // non-terminal editables and foreign chords, so nothing else is intercepted.
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const action = tabKeyAction(ev, describeTarget(ev.target));
      if (!action) return;
      ev.preventDefault();
      if (action.kind === "select-index") dispatch({ kind: "selectIndex", index: action.index });
      else if (action.kind === "split") requestSplit(action.dir);
      else {
        // trmx-86: a pane-nav chord must ALSO be kept from xterm (stopImmediatePropagation) — even at an
        // edge no-op — so ⌥⌘-arrows / ⌘]/⌘[ never leak a byte to the PTY. preventDefault alone doesn't
        // stop xterm's own textarea keydown listener; halting propagation from this capture-phase
        // listener does.
        ev.stopImmediatePropagation();
        requestPaneNav(action);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Focus follows activation / focus change: the active tab's FOCUSED pane's terminal takes the
  // keyboard. SUPPRESSED while a rename is in flight (the input keeps focus). Re-runs when the active
  // tab OR its focused pane changes (click-to-focus a sibling pane).
  const activeTab = state.tabs.find((t) => t.tabId === state.activeTabId);
  const activeFocusedPaneId = activeTab?.focusedPaneId ?? null;
  useEffect(() => {
    if (renamingTabId !== null) return;
    if (activeFocusedPaneId === null) return;
    const terminal = handlesRef.current.get(activeFocusedPaneId)?.terminal;
    (terminal as unknown as { focus?: () => void } | undefined)?.focus?.();
  }, [state.activeTabId, activeFocusedPaneId, renamingTabId]);

  // trmx-75: the NATIVE window title is the ACTIVE tab's (focused pane) effective title — background
  // tabs/panes never reach it. Undefined = no tabs yet (boot) — leave the window alone.
  const activeTitle = activeTab?.title;
  useEffect(() => {
    if (activeTitle === undefined) return;
    seamsRef.current.setWindowTitle(activeTitle);
  }, [activeTitle]);

  // trmx-75/84: the core mirror — every ATTACHED pane's effective title is written into its session
  // (set_session_title) whenever it changes, so core `Session::title` always matches the UI. The
  // per-pane dedup map bounds the invoke stream to real changes and is WHY a raw hint never leaks
  // into the core (a hint under a manual/OSC title leaves the pane title unchanged → nothing writes).
  useEffect(() => {
    for (const tab of state.tabs) {
      for (const paneId of tabPaneIds(tab)) {
        const sessionId = sessionsRef.current.get(paneId);
        if (sessionId === undefined) continue; // not attached yet
        const title = tab.panes[paneId].title;
        if (mirroredRef.current.get(paneId) === title) continue;
        mirroredRef.current.set(paneId, title);
        seamsRef.current.mirrorTitle(sessionId, title).catch((err: unknown) => {
          console.error("[termixion] title mirror failed", err);
        });
      }
    }
  }, [state.tabs]);

  // trmx-85 (FR-3.3): divider drag-resize. A pointer drag on a divider maps the pointer (converted to
  // content-area coords, matching solveRects' space) → a clamped ratio for that split (dividerDrag.ts),
  // dispatched at most ONCE per animation frame (coalesced, the trmx-67 idiom). `setPointerCapture` +
  // a drag overlay shield the terminals so xterm sees no stray pointer events mid-drag; double-click
  // resets a divider to 50/50. All drag state is refs (out-of-render); `dragDir` drives the overlay.
  const dragScheduleRef = useRef(dragSchedule);
  dragScheduleRef.current = dragSchedule;
  const [dragDir, setDragDir] = useState<SplitDir | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    tabId: number;
    path: DividerRect["path"];
    dir: SplitDir;
    bounds: Rect;
    grabOffset: number;
    contentLeft: number;
    contentTop: number;
  } | null>(null);
  const pendingRatioRef = useRef<number | null>(null);
  const frameCancelRef = useRef<(() => void) | null>(null);

  // Dispatch the latest dragged ratio at most once per frame (coalesce raw pointermoves).
  const scheduleRatioFlush = () => {
    if (frameCancelRef.current) return; // a frame is already pending — coalesce into it
    frameCancelRef.current = dragScheduleRef.current(() => {
      frameCancelRef.current = null;
      const d = dragRef.current;
      const ratio = pendingRatioRef.current;
      if (d && ratio !== null) dispatch({ kind: "setPaneRatio", tabId: d.tabId, path: d.path, ratio });
    });
  };

  // End the drag. `commit` (pointerup) APPLIES the latest pending ratio synchronously first — a quick
  // drag-and-release within a single animation frame must not be lost — whereas the abort paths
  // (pointercancel / lostpointercapture / unmount) skip the commit. Either way the pending frame is
  // cancelled and state cleared, so no dispatch ever lands after the drag has ended.
  const endDrag = (commit: boolean) => {
    if (commit) {
      const d = dragRef.current;
      const ratio = pendingRatioRef.current;
      if (d && ratio !== null) dispatch({ kind: "setPaneRatio", tabId: d.tabId, path: d.path, ratio });
    }
    if (frameCancelRef.current) {
      frameCancelRef.current();
      frameCancelRef.current = null;
    }
    pendingRatioRef.current = null;
    dragRef.current = null;
    setDragDir(null);
  };

  const pointerMainOf = (e: ReactPointerEvent, dir: SplitDir, left: number, top: number) =>
    dir === "row" ? e.clientX - left : e.clientY - top;

  // pointerdown records the grab offset (pointer − the visual line's leading edge) so the divider does
  // not jump to the cursor when the grab landed beside the 1px line inside the widened hit area.
  const onDividerPointerDown = (tabId: number, d: DividerRect) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // a divider grab must never focus a pane
    const contentRect = contentRef.current?.getBoundingClientRect();
    const contentLeft = contentRect?.left ?? 0;
    const contentTop = contentRect?.top ?? 0;
    const pointerMain = pointerMainOf(e, d.dir, contentLeft, contentTop);
    const leadingEdge = d.dir === "row" ? d.rect.x : d.rect.y;
    dragRef.current = {
      pointerId: e.pointerId,
      tabId,
      path: d.path,
      dir: d.dir,
      bounds: d.bounds,
      grabOffset: grabOffsetOf(pointerMain, leadingEdge),
      contentLeft,
      contentTop,
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDragDir(d.dir);
  };

  const onDividerPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    const pointerMain = pointerMainOf(e, d.dir, d.contentLeft, d.contentTop);
    pendingRatioRef.current = ratioForDrag({ pointerMain, grabOffset: d.grabOffset, bounds: d.bounds, dir: d.dir });
    scheduleRatioFlush();
  };

  const onDividerPointerUp = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    endDrag(true); // commit the final drag position
  };

  // pointercancel / lostpointercapture ABORT the drag (no commit) — no stuck overlay / stale frame.
  const onDividerPointerCancel = () => endDrag(false);

  const onDividerDoubleClick = (tabId: number, path: DividerRect["path"]) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    dispatch({ kind: "setPaneRatio", tabId, path, ratio: RESET_RATIO });
  };

  // Cleanup on unmount: a mid-drag unmount must not leave a queued frame to dispatch into a dead reducer.
  useEffect(() => {
    return () => {
      if (frameCancelRef.current) frameCancelRef.current();
    };
  }, []);

  // trmx-81: the position class + the strip's axis. The JSX order NEVER changes (hosts first, strip
  // LAST): barLayoutFor's flex direction moves the bar; the keyed pane hosts stay put (keep-alive).
  const barLayout = barLayoutFor(barPosition);
  const labelOrientation = labelOrientationFor(barPosition, sideLabelOrientation);

  return (
    <main className={`app app--bar-${barPosition}`}>
      <div className="tab-hosts" ref={contentRef}>
        {state.tabs.map((tab) => {
          // KEEP-ALIVE: every tab's host stays mounted (keyed by the never-reused tabId); switching
          // only toggles visibility. trmx-84: within it, each pane is an absolutely-positioned
          // sibling keyed by paneId, laid out from solveRects — a re-layout mutates only style.
          const solved = solveRects(tab.tree, bounds);
          // trmx-87 (FR-3.6): the dividers OUTLINING the focused pane render in the active border color;
          // the rest inactive. A pure class flip — no re-layout, no terminal touch.
          const activeKeys = activeDividerKeys(solved.panes, solved.dividers, tab.focusedPaneId);
          return (
            <div
              key={tab.tabId}
              className="tab-host"
              data-testid={`tab-host-${tab.tabId}`}
              style={{ display: tab.tabId === state.activeTabId ? undefined : "none" }}
            >
              {solved.panes.map(({ paneId, rect }) => (
                <div
                  key={paneId}
                  className={
                    paneId === tab.focusedPaneId ? "pane-host pane-host--focused" : "pane-host"
                  }
                  data-testid={`pane-host-${paneId}`}
                  style={{
                    position: "absolute",
                    left: rect.x,
                    top: rect.y,
                    width: rect.width,
                    height: rect.height,
                  }}
                  // Click-to-focus: capture phase so a click anywhere in the pane focuses it, WITHOUT
                  // preventDefault — xterm still starts its text selection on the same mousedown.
                  onMouseDownCapture={() => {
                    if (tab.focusedPaneId !== paneId) {
                      dispatch({ kind: "focusPane", tabId: tab.tabId, paneId });
                    }
                  }}
                >
                  <TerminalView
                    onReady={readyFor(tab.tabId, paneId)}
                    cwdStore={storeFor(paneId)}
                    onOscTitle={oscTitleFor(tab.tabId, paneId)}
                  />
                </div>
              ))}
              {solved.dividers.map((d) => (
                // trmx-85: 1px visual line + a widened (~7px) hit area (index.css) that drag-resizes the
                // split. Pointer handlers stopPropagation so a grab never focuses a pane; double-click
                // resets to 50/50. Chrome/styling is FR-3.6.
                <div
                  key={`divider-${d.path.join("-") || "root"}`}
                  className={`pane-divider pane-divider--${d.dir} ${
                    activeKeys.has(dividerKey(d.path)) ? "pane-divider--active" : "pane-divider--inactive"
                  }`}
                  data-testid={`pane-divider-${d.path.join("-") || "root"}`}
                  style={{
                    position: "absolute",
                    left: d.rect.x,
                    top: d.rect.y,
                    width: d.rect.width,
                    height: d.rect.height,
                  }}
                  onPointerDown={onDividerPointerDown(tab.tabId, d)}
                  onPointerMove={onDividerPointerMove}
                  onPointerUp={onDividerPointerUp}
                  onPointerCancel={onDividerPointerCancel}
                  onLostPointerCapture={onDividerPointerCancel}
                  onDoubleClick={onDividerDoubleClick(tab.tabId, d.path)}
                />
              ))}
            </div>
          );
        })}
        {/* trmx-85: while dragging a divider, a transparent overlay owns the pointer (with the resize
            cursor) so xterm receives no stray mouse events. Removed on every drag-end path (endDrag). */}
        {dragDir !== null && (
          <div
            className={`pane-drag-overlay pane-drag-overlay--${dragDir}`}
            data-testid="pane-drag-overlay"
          />
        )}
      </div>
      <TabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        renamingTabId={renamingTabId}
        orientation={barLayout.orientation}
        labelOrientation={labelOrientation}
        onActivate={(tabId) => dispatch({ kind: "activateTab", tabId })}
        onClose={requestCloseTab}
        onNew={requestNewTab}
        onMove={(from, to) => dispatch({ kind: "moveTab", from, to })}
        onRenameStart={startRename}
        onRenameCommit={commitRename}
        onRenameCancel={cancelRename}
      />
      <UpdateAuthorityHost />
    </main>
  );
}
