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
// trmx-74: App is the TAB MANAGER — a `useReducer` shell over the pure tab model (tabState.ts)
// composing the strip (TabStrip.tsx), the keymap (tabKeymap.ts), and the session-scoped backend:
// - KEEP-ALIVE: every tab renders a persistent sibling host (inactive ones display:none); a
//   terminal unmounts only when its tab CLOSES, so scrollback/processes survive switches.
// - Attach is async (open_pty): a tab is born session-less, binds on resolution — and if it died
//   mid-flight, the ORPHAN session is disposed (the reducer never resurrects, App never leaks).
// - Each tab gets its OWN OSC 7 CwdStore from mount, so a new tab inherits the ACTIVE tab's cwd
//   (captured at request time into pendingCwd — works even mid-attach).
// - `pty:exited` closes the dead session's tab (no redundant close_pty); the menu's `tabs:action`
//   broadcasts (⌘T/⌘W/⇧⌘[/⇧⌘]) drive new/close/next/prev; ⌘1..⌘9 select by index (capture-phase
//   window keydown via tabKeymap).
// - Closing the LAST tab closes the WINDOW (the backend's CloseRequested kill_all owns cleanup).
// Every runtime edge is an injectable seam prop with a real default (the TerminalView pattern),
// so App.test.tsx drives all of it headless with fakes.
//
// trmx-75 (FR-2.4): App is also the TITLE ROUTER over the layered sources (tabTitle.ts):
// - Each tab's OSC 0/2 titles arrive over a per-tab cached `onOscTitle` callback (identity-stable
//   like `readyFor` — an unstable one would remount the terminal) → the reducer's `osc` slot.
// - The poller's `session:title-hint` broadcasts route by sessionId → the `process` slot
//   (unknown sessions inert — a hint can race a close).
// - The NATIVE window title mirrors only the ACTIVE tab's effective title (background isolation).
// - The core mirror writes each tab's EFFECTIVE title into its attached session
//   (`set_session_title` — App is the SOLE core-title writer; hints never reach the core raw).
// - Rename UI: `renamingTabId` lives here; menu "rename" targets the active tab, a label
//   double-click activates + renames; while renaming, focus-follows-activation is SUPPRESSED so
//   the input keeps the keyboard, and commit/cancel hands focus back to the terminal.
//
// trmx-81 (FR-2.2): App also OWNS the tab-bar position — seeded from the shared settings snapshot
// (tabs.barPosition), kept live over settings:changed (payload-guarded; junk inert), and applied
// as an `app--bar-<position>` class on main.app. The JSX order NEVER changes (hosts first, strip
// LAST): barLayoutFor's flex direction moves the bar to the edge, so the keyed hosts — and their
// keep-alive terminals — are untouched by a position switch (the trmx-74 remount lesson).
import { useEffect, useReducer, useRef, useState } from "react";
import { TerminalView, type SettingsObservation } from "./terminal/TerminalView";
import { TabStrip } from "./tabs/TabStrip";
import { barLayoutFor } from "./tabs/barLayout";
import {
  initialTabsState,
  reduceTabs,
  tabBySessionId,
} from "./tabs/tabState";
import {
  isTabBarPosition,
  makeSettingsStore,
  SETTINGS_CHANGED_EVENT,
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

/** The menu's tab-intent broadcast (main.rs emits "new"/"close"/"next"/"prev", trmx-74). */
export const TABS_ACTION_EVENT = "tabs:action";

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
}: AppProps = {}) {
  const { attachTerminal } = useBackend();
  const attachFn = attach ?? attachTerminal;

  const [state, dispatch] = useReducer(reduceTabs, undefined, initialTabsState);
  // trmx-75: the tab whose label is an inline rename input (null = not renaming). While non-null,
  // focus-follows-activation is suppressed so the input keeps the keyboard.
  const [renamingTabId, setRenamingTabId] = useState<number | null>(null);
  // trmx-81: the tab bar's window edge, seeded from the shared settings snapshot (hydrated before
  // mount, main.tsx boot order) — the lazy initializer reads it exactly once per App lifetime.
  const [barPosition, setBarPosition] = useState<TabBarPosition>(() =>
    makeSettingsStore().get("tabs.barPosition"),
  );

  // Mirror of the reducer state for callbacks that fire OUTSIDE the render cycle (attach
  // resolutions, event subscriptions) — kept current by the effect below.
  const stateRef = useRef(state);
  // Per-tab plumbing, all keyed by tabId (ids are never reused, tabState.ts):
  const storesRef = useRef(new Map<number, CwdStore>()); // OSC 7 cwd, one store per tab
  const handlesRef = useRef(new Map<number, TerminalHandle>()); // mounted terminals
  const sessionsRef = useRef(new Map<number, number>()); // attached backend sessionIds
  const pendingCwdRef = useRef(new Map<number, string | undefined>()); // cwd to seed the open with
  const readyCbsRef = useRef(new Map<number, (handle: TerminalHandle) => void>()); // stable onReady per tab
  const oscTitleCbsRef = useRef(new Map<number, (title: string) => void>()); // stable onOscTitle per tab (trmx-75)
  const mirroredRef = useRef(new Map<number, string>()); // last title mirrored to the core, per tab (trmx-75)
  // Attach epoch per tab: each onReady invocation bumps it, and a resolution whose epoch is no
  // longer current is STALE. StrictMode's dev mount→unmount→remount fires onReady twice for the
  // same live tab, opening two PTYs — only the epoch that matches keeps its session; the stale
  // one is closed no matter which order the two open_pty calls resolve in (trmx-74 review).
  const attachEpochRef = useRef(new Map<number, number>());
  const bootedRef = useRef(false);

  // Latest-seam ref: the cached per-tab onReady callbacks (stable identity — an inline arrow
  // would remount the terminal via TerminalView's effect deps) read the CURRENT seams through it.
  const seamsRef = useRef({ attach: attachFn, closeWindow, closeSession, setWindowTitle, mirrorTitle });
  seamsRef.current = { attach: attachFn, closeWindow, closeSession, setWindowTitle, mirrorTitle };

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Boot: exactly ONE initial tab. The ref guards StrictMode's double effect-invocation — the
  // state check alone can't (the second run may observe the pre-dispatch state).
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (stateRef.current.tabs.length === 0) dispatch({ kind: "openTab" });
  }, []);

  // This tab's cwd store, created lazily at RENDER time — so it exists from the terminal's mount
  // and an OSC 7 report (or a cwd-inheritance capture) can land before the session attaches.
  const storeFor = (tabId: number): CwdStore => {
    let store = storesRef.current.get(tabId);
    if (!store) {
      store = makeCwdStore();
      storesRef.current.set(tabId, store);
    }
    return store;
  };

  // This tab's onReady, cached so its identity never changes across App re-renders (keep-alive:
  // TerminalView's effect must not re-run on a tab switch). It wires the mounted terminal to a
  // live session; if the tab died while open_pty was in flight, the resolved session is an
  // ORPHAN — dispose it (the reducer's attachSession would no-op anyway; the resource is ours).
  const readyFor = (tabId: number): ((handle: TerminalHandle) => void) => {
    let cb = readyCbsRef.current.get(tabId);
    if (!cb) {
      cb = (handle) => {
        handlesRef.current.set(tabId, handle);
        const epoch = (attachEpochRef.current.get(tabId) ?? 0) + 1;
        attachEpochRef.current.set(tabId, epoch);
        seamsRef.current
          .attach(handle, { cwd: pendingCwdRef.current.get(tabId) })
          .then((info) => {
            const tabAlive = stateRef.current.tabs.some((t) => t.tabId === tabId);
            const epochCurrent = attachEpochRef.current.get(tabId) === epoch;
            if (tabAlive && epochCurrent) {
              sessionsRef.current.set(tabId, info.sessionId);
              dispatch({
                kind: "attachSession",
                tabId,
                sessionId: info.sessionId,
                title: info.title,
              });
            } else {
              // ORPHAN GUARD: the tab closed mid-attach, OR this resolution is from a superseded
              // mount (StrictMode remount bumped the epoch) — kill the session it will never show.
              seamsRef.current.closeSession(info.sessionId).catch((err: unknown) => {
                console.error("[termixion] orphan session close failed", err);
              });
            }
          })
          .catch((err: unknown) => {
            // Open failed (no backend in `pnpm dev`, or a real spawn error): the tab stays on its
            // placeholder title with a dead pane — do not crash the shell.
            console.error("[termixion] tab attach failed", err);
          });
      };
      readyCbsRef.current.set(tabId, cb);
    }
    return cb;
  };

  // This tab's onOscTitle, cached like `readyFor` (an unstable identity would remount the
  // terminal via TerminalView's effect deps — keep-alive). A program's OSC 0/2 title lands in
  // the reducer's `osc` slot; the EMPTY string is the escape sequence's reset (printf '\e]2;\a')
  // and clears the slot (trmx-75 empty-OSC-clears rule). Sanitization lives in the reducer.
  const oscTitleFor = (tabId: number): ((title: string) => void) => {
    let cb = oscTitleCbsRef.current.get(tabId);
    if (!cb) {
      cb = (title) => {
        dispatch({
          kind: "setTitleSource",
          tabId,
          source: "osc",
          value: title === "" ? null : title,
        });
      };
      oscTitleCbsRef.current.set(tabId, cb);
    }
    return cb;
  };

  // Open a new tab inheriting the ACTIVE tab's cwd: capture it NOW (the user's intent is "where I
  // am"), keyed by the id the reducer WILL allocate (nextTabId — read before dispatch, mirroring
  // the reducer's own allocation). The active tab's store exists from mount, so this works even
  // while that tab is itself still mid-attach.
  const requestNewTab = () => {
    const s = stateRef.current;
    const upcomingTabId = s.nextTabId;
    const activeStore = s.activeTabId !== null ? storesRef.current.get(s.activeTabId) : undefined;
    pendingCwdRef.current.set(upcomingTabId, activeStore?.get() ?? undefined);
    dispatch({ kind: "openTab" });
  };

  // Close one tab. The LAST tab closes the WINDOW instead — no dispatch, no per-session close:
  // the backend's CloseRequested handler kill_all's everything. Otherwise the reducer drops the
  // tab (activating the iTerm2 neighbor) and the attached session is closed best-effort — unless
  // it `alreadyExited` (the pty:exited path), where a close_pty would be redundant noise.
  const closeTabInternal = (tabId: number, opts?: { alreadyExited?: boolean }) => {
    const s = stateRef.current;
    if (!s.tabs.some((t) => t.tabId === tabId)) return;
    if (s.tabs.length <= 1) {
      seamsRef.current.closeWindow();
      return;
    }
    dispatch({ kind: "closeTab", tabId });
    const sessionId = sessionsRef.current.get(tabId);
    sessionsRef.current.delete(tabId);
    handlesRef.current.delete(tabId);
    storesRef.current.delete(tabId);
    pendingCwdRef.current.delete(tabId);
    readyCbsRef.current.delete(tabId);
    oscTitleCbsRef.current.delete(tabId);
    mirroredRef.current.delete(tabId);
    // trmx-75: a tab dying MID-RENAME (e.g. its shell exited) must clear the rename state, or a
    // stuck non-null renamingTabId would suppress focus-follows-activation forever. Functional
    // update — this callback runs outside the render cycle and must not read stale state.
    setRenamingTabId((current) => (current === tabId ? null : current));
    if (sessionId !== undefined && !opts?.alreadyExited) {
      closeSessionOf(sessionId);
    }
  };

  const closeSessionOf = (sessionId: number) => {
    seamsRef.current.closeSession(sessionId).catch((err: unknown) => {
      console.error("[termixion] close pty failed", err);
    });
  };

  const requestCloseTab = (tabId: number) => closeTabInternal(tabId);

  // trmx-75: the rename intents. Start = activate + flip into rename (the double-click path — a
  // background tab's label must both surface its terminal AND open the editor); commit maps an
  // empty-after-trim value to null, the reducer's clear-to-auto (the osc/process/fallback layers
  // resurface); cancel just drops the edit. Commit/cancel clearing `renamingTabId` re-runs the
  // focus effect below, handing the keyboard back to the active tab's terminal.
  const startRename = (tabId: number) => {
    dispatch({ kind: "activateTab", tabId });
    setRenamingTabId(tabId);
  };
  const commitRename = (tabId: number, value: string) => {
    dispatch({
      kind: "setTitleSource",
      tabId,
      source: "manual",
      value: value.trim() === "" ? null : value,
    });
    setRenamingTabId(null);
  };
  const cancelRename = () => setRenamingTabId(null);

  // Subscriptions: the backend's pty:exited (a shell exited → its tab closes, session already
  // dead), the poller's session:title-hint (trmx-75 — route by sessionId into the `process`
  // title slot; a hint for a session no tab owns raced a close and is inert), and the menu's
  // tabs:action intents. One effect, teardown-safe; the handlers reach state through stateRef
  // only, so the first render's closures never go stale.
  useEffect(() => {
    const stopExited = observePtyExited((sessionId) => {
      const tab = tabBySessionId(stateRef.current, sessionId);
      if (tab) closeTabInternal(tab.tabId, { alreadyExited: true });
    });
    const stopTitleHints = observeTitleHint((sessionId, name) => {
      const tab = tabBySessionId(stateRef.current, sessionId);
      if (tab) {
        dispatch({ kind: "setTitleSource", tabId: tab.tabId, source: "process", value: name });
      }
    });
    const stopTabsAction = observeTabsAction((payload) => {
      // Events are untrusted input (cf. onPtyExited's payload guard): only the exact verb
      // strings act; junk is inert.
      if (payload === "new") requestNewTab();
      else if (payload === "close") {
        const active = stateRef.current.activeTabId;
        if (active !== null) closeTabInternal(active);
      } else if (payload === "next") dispatch({ kind: "nextTab" });
      else if (payload === "prev") dispatch({ kind: "prevTab" });
      else if (payload === "rename") {
        // trmx-75: the Shell ▸ Rename Tab… menu item targets the ACTIVE tab (guard: only when
        // a tab actually exists — activeTabId is null exactly when the strip is empty).
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

  // trmx-81: keep the bar position live over settings:changed (the settings window, a config-file
  // hand edit, a reset's default broadcast). Its OWN effect, dep'd only on the stable observation
  // seam — it must never re-run with the tab-state effects (no effect-dep churn; every identity
  // App passes to TerminalView stays untouched by a position change). Payloads are untrusted
  // input: only a well-formed tabs.barPosition with a registry-valid value updates state.
  useEffect(() => {
    const stopSettings = observeSettings((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const { key, value } = payload as { key?: unknown; value?: unknown };
      if (key === "tabs.barPosition" && isTabBarPosition(value)) setBarPosition(value);
    });
    return stopSettings;
  }, [observeSettings]);

  // ⌘1..⌘9 select a tab by index (⌘9 = last, the reducer's rule). Capture phase on window so the
  // chord wins even while xterm's helper textarea has focus; tabKeymap vetoes non-terminal
  // editables and foreign chords, so nothing else is ever intercepted.
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const action = tabKeyAction(ev, describeTarget(ev.target));
      if (action) {
        ev.preventDefault();
        dispatch({ kind: "selectIndex", index: action.index });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Focus follows activation: the newly active tab's terminal takes the keyboard. `focus()` is
  // on the real xterm Terminal but outside TerminalLike's deliberate narrowness — the localized
  // adapter cast (cf. useBackend's rows/cols read); bare test fakes may omit it.
  // trmx-75 focus discipline: SUPPRESSED while a rename is in flight — the double-click path
  // activates the tab in the same batch that opens the input, and stealing focus back to the
  // terminal would kill the edit. When renamingTabId returns to null (commit/cancel/tab-death),
  // the dep change re-runs this effect and the active tab's terminal takes the keyboard back.
  useEffect(() => {
    if (renamingTabId !== null) return;
    if (state.activeTabId === null) return;
    const terminal = handlesRef.current.get(state.activeTabId)?.terminal;
    (terminal as unknown as { focus?: () => void } | undefined)?.focus?.();
  }, [state.activeTabId, renamingTabId]);

  // trmx-75: the NATIVE window title is the ACTIVE tab's effective title — background tabs never
  // reach it (their OSC titles stop at their strip labels), and a switch re-fires because the
  // rendered `activeTitle` changes. Undefined = no tabs yet (boot) — leave the window alone.
  const activeTitle = state.tabs.find((t) => t.tabId === state.activeTabId)?.title;
  useEffect(() => {
    if (activeTitle === undefined) return;
    seamsRef.current.setWindowTitle(activeTitle);
  }, [activeTitle]);

  // trmx-75: the core mirror — every ATTACHED tab's effective title is written into its session
  // (set_session_title) whenever it changes, so core `Session::title` always matches the UI. The
  // per-tab dedup map is load-bearing twice over: it bounds the invoke stream to real changes,
  // and it is WHY a raw hint can never leak into the core — a process hint under a manual/OSC
  // title leaves `tab.title` unchanged, so nothing is written. Fire-and-forget with a catch: a
  // lost race against a closing session must not crash the shell.
  useEffect(() => {
    for (const tab of state.tabs) {
      const sessionId = sessionsRef.current.get(tab.tabId);
      if (sessionId === undefined) continue; // not attached yet — nothing to mirror into
      if (mirroredRef.current.get(tab.tabId) === tab.title) continue;
      mirroredRef.current.set(tab.tabId, tab.title);
      seamsRef.current.mirrorTitle(sessionId, tab.title).catch((err: unknown) => {
        console.error("[termixion] title mirror failed", err);
      });
    }
  }, [state.tabs]);

  // trmx-81: the position class + the strip's axis, both from the pure layout engine. The class
  // drives index.css's flex-direction variants; the JSX below keeps hosts-then-strip order ALWAYS.
  const barLayout = barLayoutFor(barPosition);

  return (
    <main className={`app app--bar-${barPosition}`}>
      <div className="tab-hosts">
        {state.tabs.map((tab) => (
          // KEEP-ALIVE: every tab's host stays mounted (keyed by the never-reused tabId);
          // switching only toggles visibility. A terminal unmounts ONLY when its tab closes.
          <div
            key={tab.tabId}
            className="tab-host"
            data-testid={`tab-host-${tab.tabId}`}
            style={{ display: tab.tabId === state.activeTabId ? undefined : "none" }}
          >
            <TerminalView
              onReady={readyFor(tab.tabId)}
              cwdStore={storeFor(tab.tabId)}
              onOscTitle={oscTitleFor(tab.tabId)}
            />
          </div>
        ))}
      </div>
      <TabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        renamingTabId={renamingTabId}
        orientation={barLayout.orientation}
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
