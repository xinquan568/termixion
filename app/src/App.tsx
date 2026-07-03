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
import { useEffect, useReducer, useRef } from "react";
import { TerminalView } from "./terminal/TerminalView";
import { TabStrip } from "./tabs/TabStrip";
import {
  initialTabsState,
  reduceTabs,
  tabBySessionId,
} from "./tabs/tabState";
import { describeTarget, tabKeyAction } from "./tabs/tabKeymap";
import { useBackend } from "./ipc/useBackend";
import { closePty, onPtyExited, type SessionInfo } from "./ipc/backend";
import { realEventBus } from "./ipc/eventBus";
import { makeCwdStore, type CwdStore } from "./terminal/osc7";
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
}

export function App({
  attach,
  closeWindow = realCloseWindow,
  closeSession = closePty,
  observeTabsAction = realObserveTabsAction,
  observePtyExited = onPtyExited,
}: AppProps = {}) {
  const { attachTerminal } = useBackend();
  const attachFn = attach ?? attachTerminal;

  const [state, dispatch] = useReducer(reduceTabs, undefined, initialTabsState);

  // Mirror of the reducer state for callbacks that fire OUTSIDE the render cycle (attach
  // resolutions, event subscriptions) — kept current by the effect below.
  const stateRef = useRef(state);
  // Per-tab plumbing, all keyed by tabId (ids are never reused, tabState.ts):
  const storesRef = useRef(new Map<number, CwdStore>()); // OSC 7 cwd, one store per tab
  const handlesRef = useRef(new Map<number, TerminalHandle>()); // mounted terminals
  const sessionsRef = useRef(new Map<number, number>()); // attached backend sessionIds
  const pendingCwdRef = useRef(new Map<number, string | undefined>()); // cwd to seed the open with
  const readyCbsRef = useRef(new Map<number, (handle: TerminalHandle) => void>()); // stable onReady per tab
  const bootedRef = useRef(false);

  // Latest-seam ref: the cached per-tab onReady callbacks (stable identity — an inline arrow
  // would remount the terminal via TerminalView's effect deps) read the CURRENT seams through it.
  const seamsRef = useRef({ attach: attachFn, closeWindow, closeSession });
  seamsRef.current = { attach: attachFn, closeWindow, closeSession };

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
        seamsRef.current
          .attach(handle, { cwd: pendingCwdRef.current.get(tabId) })
          .then((info) => {
            if (stateRef.current.tabs.some((t) => t.tabId === tabId)) {
              sessionsRef.current.set(tabId, info.sessionId);
              dispatch({
                kind: "attachSession",
                tabId,
                sessionId: info.sessionId,
                title: info.title,
              });
            } else {
              // ORPHAN GUARD: the tab closed mid-attach — kill the session it will never show.
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

  // Subscriptions: the backend's pty:exited (a shell exited → its tab closes, session already
  // dead) and the menu's tabs:action intents. One effect, teardown-safe; the handlers reach
  // state through stateRef only, so the first render's closures never go stale.
  useEffect(() => {
    const stopExited = observePtyExited((sessionId) => {
      const tab = tabBySessionId(stateRef.current, sessionId);
      if (tab) closeTabInternal(tab.tabId, { alreadyExited: true });
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
    });
    return () => {
      stopExited();
      stopTabsAction();
    };
  }, [observePtyExited, observeTabsAction]);

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
  useEffect(() => {
    if (state.activeTabId === null) return;
    const terminal = handlesRef.current.get(state.activeTabId)?.terminal;
    (terminal as unknown as { focus?: () => void } | undefined)?.focus?.();
  }, [state.activeTabId]);

  return (
    <main className="app">
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
            <TerminalView onReady={readyFor(tab.tabId)} cwdStore={storeFor(tab.tabId)} />
          </div>
        ))}
      </div>
      <TabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onActivate={(tabId) => dispatch({ kind: "activateTab", tabId })}
        onClose={requestCloseTab}
        onNew={requestNewTab}
        onMove={(from, to) => dispatch({ kind: "moveTab", from, to })}
      />
      <UpdateAuthorityHost />
    </main>
  );
}
