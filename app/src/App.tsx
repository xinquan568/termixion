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
// - Titles (trmx-75/166): each pane has its own automatic title; the tab label + native window title
//   follow the ACTIVE tab's title, which is the tab-scoped manual PIN when set (trmx-166) else the
//   focused pane's effective title. A background pane's OSC/hint updates its own state only. Rename
//   sets the TAB's manual pin (survives pane focus/splits), not a per-pane title.
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TerminalView, type SettingsObservation } from "./terminal/TerminalView";
import { TitleBar } from "./chrome/TitleBar";
import { ConfigWarningsBadge } from "./chrome/ConfigWarningsBadge";
import { AiSessionCounter } from "./chrome/AiSessionCounter";
import { NAMED_BUCKETS, sessionsFrom, type AiSession } from "./chrome/aiSessionBuckets";
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
  canDropEdge,
  MIN_PANE_PX,
  setRatio as setRatioTree,
  solveRects,
  type DividerRect,
  type PaneId,
  type Rect,
  type SplitDir,
} from "./panes/layoutTree";
import { grabOffsetOf, ratioForDrag, RESET_RATIO } from "./panes/dividerDrag";
import { dropZone, type DropZone } from "./panes/dropZone";
import { nextPane, paneInDirection, type Direction } from "./panes/paneNav";
import { activeDividerSegments, dividerKey } from "./panes/paneChrome";
import { BadgeOverlay } from "./panes/BadgeOverlay";
import { ActivityLineOverlay } from "./panes/ActivityLineOverlay";
import { initialActivity, lightActive, onManualToggle } from "./panes/activityLine";
import {
  collectBusyPanes,
  collectBusyTabs,
  paneIsBusy,
  shouldConfirmClose,
  type BusyLookup,
} from "./panes/closeGuard";
import { ConfirmCloseDialog } from "./panes/ConfirmCloseDialog";
import { type FrameSchedule } from "./terminal/resizeCoalescer";
import {
  isLabelOrientation,
  isTabBarPosition,
  makeSettingsStore,
  type LabelOrientation,
  type TabBarPosition,
} from "./store/settingsStore";
import { describeTarget } from "./tabs/tabKeymap";
import { normalizeLegacyThemeId } from "./theme/defaultTheme";
import { isRegisteredThemeId, isUserThemeIdShape, resolveTheme } from "./theme/registry";
import { applyTxTheme } from "./theme/txCssVars";
import { FindBar } from "./search/FindBar";
import { useBackend } from "./ipc/useBackend";
import {
  closePty,
  onPtyExited,
  onSessionActivity,
  onTitleHint,
  realInvoke,
  sendPtyInput,
  takePendingOpenPaths,
  type InvokeFn,
} from "./ipc/backend";
import { realObserveServiceNudge, type ServiceNudgeObservation } from "./ipc/serviceNudge";
import { makeIdReservation, type IdReservation } from "./tabs/idReservation";
import { shouldFocusOnHover } from "./panes/focusFollowsMouse";
import { ScriptPicker } from "./scripts/ScriptPicker";
import { listScripts, type ScriptEntry } from "./scripts/scriptsBackend";
import { buildCommands, type Command, type CommandContext } from "./commands/registry";
import { createDispatcher, type Dispatcher } from "./commands/dispatch";
import {
  FULL_DEFAULT_KEYS,
  mergeKeymap,
  resolve as resolveKeymap,
} from "./commands/keymapDispatch";
import { onKeysChanged, readKeys } from "./commands/keysBackend";
import { CommandPalette } from "./commands/CommandPalette";
import { growTarget } from "./commands/growPane";
import { listThemes } from "./theme/registry";
import { realEventBus } from "./ipc/eventBus";
import { routeControlRequest, buildLsSnapshot, type ControlDeps } from "./control/controlBridge";
import { installThemeHotReload } from "./startup/themeHotReload";
import { makeCwdStore } from "./terminal/osc7";
import { createPaneRuntimes, type PaneRuntime } from "./app/paneRuntime";
import { usePaneCallbacks } from "./app/usePaneCallbacks";
import { usePaneActivity } from "./app/usePaneActivity";
import { realSetWindowTitle } from "./terminal/windowTitle";
import { UpdateAuthorityHost } from "./update/UpdateAuthorityHost";
import { log } from "./ipc/logSink";


// trmx-247: realCloseWindow / realCloseAcknowledged / realQuitConfirmed moved to ipc/window.ts.
import {
  realCloseAcknowledged,
  realCloseWindow,
  realQuitConfirmed,
} from "./ipc/window";

// trmx-254: App.tsx's old module head, relocated by dependency (see the LEVELS map). The split is
// not cosmetic: `ipc/` is L0 and may not import theme/, terminal/ or control/, so the seams that
// reach into those zones live with them instead.
import {
  isAskGeneration,
  realObserveCloseRequested,
  realObserveSessionNotice,
  realObserveTabsAction,
  type CloseRequestedObservation,
  type InputObservation,
  type OutputObservation,
  type PtyExitedObservation,
  type SessionNoticeObservation,
  type TabsActionObservation,
  type TitleHintObservation,
} from "./ipc/appEvents";
import { activityErrorColorFor, activityIsDarkFor } from "./theme/activityColors";
import { DEFAULT_BOUNDS, FALLBACK_BADGE_COLS, type ActivityObservation } from "./panes/appConstants";
import type { CloseOpts, PendingClose } from "./app/closeContracts";
import {
  realFrameSchedule,
  realObserveAppSettings,
  writePaneNotice,
  type AttachFn,
} from "./terminal/appSeams";
import { realObserveControlRequest, type ControlRequestObservation } from "./control/controlRequestSeam";

// trmx-254: the `ControlRequest` facade stays exported from App.tsx so existing importers
// (App.confirmClose.test.tsx) keep working; the seam itself now lives in control/.
export type { ControlRequest } from "./control/controlRequestGuard";

export interface AppProps {
  /** Injection seam for tests; defaults to useBackend's attachTerminal (the live PTY wiring). */
  attach?: AttachFn;
  /** Injection seam for tests; defaults to closing the native window (last-tab close). */
  closeWindow?: () => void;
  /** Injection seam for tests; defaults to the real `quit_confirmed` invoke (trmx-144). */
  quitConfirmed?: () => void;
  /** trmx-268: tell the backend the webview is alive, echoing the ask generation. */
  closeAcknowledged?: (generation: number) => Promise<void>;
  /** Injection seam for tests; defaults to the real `close_pty` command. */
  closeSession?: (sessionId: number) => Promise<void>;
  /** Injection seam for tests; defaults to the real `tabs:action` event-bus subscription. */
  observeTabsAction?: TabsActionObservation;
  /** Injection seam for tests; defaults to the real `pty:exited` event-bus subscription. */
  observePtyExited?: PtyExitedObservation;
  /** Injection seam for tests; defaults to the real `session:title-hint` subscription (trmx-75). */
  observeTitleHint?: TitleHintObservation;
  /** Injection seam for tests; defaults to the real `session:activity` subscription (trmx-91). */
  observeActivity?: ActivityObservation;
  /** Injection seam for tests (trmx-159); production observes PTY output via useBackend directly. */
  observeOutput?: OutputObservation;
  /** Injection seam for tests (trmx-159); production observes keystroke input via useBackend directly. */
  observeInput?: InputObservation;
  /** Injection seam for tests; defaults to the real `settings:changed` subscription (trmx-81). */
  observeSettings?: SettingsObservation;
  /** Injection seam for tests; the control socket's request stream (trmx-101). */
  observeControlRequest?: ControlRequestObservation;
  /** Injection seam for tests; the backend's per-session notice stream (trmx-237 H4). */
  observeSessionNotice?: SessionNoticeObservation;
  /** Injection seam for tests; the backend's `close:requested` stream (trmx-144). */
  observeCloseRequested?: CloseRequestedObservation;
  /** Injection seam for tests; defaults to retitling the native window (trmx-75). */
  setWindowTitle?: (title: string) => void;
  /** Injection seam for tests; the frame schedule that throttles divider-drag dispatches (trmx-85). */
  dragSchedule?: FrameSchedule;
  /** Injection seam for tests; defaults to the real themes hot-reload installer (trmx-89). */
  installHotReload?: typeof installThemeHotReload;
  /** Injection seam for tests; defaults to the real `pty_write` (trmx-93 — sends a sourced script). */
  sendInput?: (sessionId: number, data: string) => Promise<void>;
  /** Injection seam for tests; the backend `invoke` for the script picker + startup resolution (trmx-93). */
  invoke?: InvokeFn;
  /** trmx-224: cold-launch service dirs, pre-fetched by main.tsx BEFORE mount (so plain boot
   * stays synchronous). Non-empty ⇒ these become the initial tabs (first focused) and the
   * default tab + startup script are skipped. */
  serviceBootPaths?: string[];
  /** Injection seam for tests; defaults to the real `services:open-paths` subscription (trmx-224). */
  observeServiceNudge?: ServiceNudgeObservation;
}

export function App({
  attach,
  closeWindow = realCloseWindow,
  quitConfirmed = realQuitConfirmed,
  closeAcknowledged = realCloseAcknowledged,
  closeSession = closePty,
  observeTabsAction = realObserveTabsAction,
  observePtyExited = onPtyExited,
  observeTitleHint = onTitleHint,
  observeActivity = onSessionActivity,
  observeOutput,
  observeInput,
  observeSettings = realObserveAppSettings,
  observeControlRequest = realObserveControlRequest,
  observeSessionNotice = realObserveSessionNotice,
  observeCloseRequested = realObserveCloseRequested,
  setWindowTitle = realSetWindowTitle,
  dragSchedule = realFrameSchedule,
  installHotReload = installThemeHotReload,
  sendInput = (sessionId, data) => sendPtyInput(sessionId, data),
  invoke = realInvoke,
  serviceBootPaths = [],
  observeServiceNudge = realObserveServiceNudge,
}: AppProps = {}) {
  // trmx-159: the per-pane I/O observers route PTY output/input into the activity classifier. They are
  // set (below, once applyActivityTransition exists) into this ref, which the stable useBackend wiring
  // and the test-only observeOutput/observeInput seams both read — so production observes I/O through
  // the live terminal (useBackend) while tests drive it through the injection seams.
  const ioObserversRef = useRef<{
    output: (sessionId: number, byteLength: number) => void;
    input: (sessionId: number, data: string) => void;
  }>({ output: () => {}, input: () => {} });
  const { attachTerminal } = useBackend({
    onOutput: (sessionId, byteLength) => ioObserversRef.current.output(sessionId, byteLength),
    onInput: (sessionId, data) => ioObserversRef.current.input(sessionId, data),
  });
  const attachFn = attach ?? attachTerminal;

  const [state, dispatch] = useReducer(reduceTabs, undefined, initialTabsState);
  // trmx-224: the shared ID-reservation authority. Counters advance at RESERVATION time
  // (stateRef advances only on commit, so a promise continuation can interleave with a
  // dispatched-but-uncommitted creation — idReservation.ts). One reservation per
  // counter-advancing dispatch, made by the dispatching code itself.
  const reservationRef = useRef<IdReservation | null>(null);
  if (reservationRef.current === null) {
    reservationRef.current = makeIdReservation({
      nextTabId: state.nextTabId,
      nextPaneId: state.nextPaneId,
    });
  }
  const reservation = reservationRef.current;
  // trmx-75/166: the tab whose label is an inline rename input (null = not renaming). Commit sets
  // that TAB's manual title pin. While non-null, focus-follows-activation is suppressed.
  const [renamingTabId, setRenamingTabId] = useState<number | null>(null);
  // trmx-81/82: the tab bar's window edge + side-label orientation, seeded from the shared settings
  // snapshot (hydrated before mount), kept live over settings:changed.
  const [barPosition, setBarPosition] = useState<TabBarPosition>(() =>
    makeSettingsStore().get("tabs.barPosition"),
  );
  const [sideLabelOrientation, setSideLabelOrientation] = useState<LabelOrientation>(() =>
    makeSettingsStore().get("tabs.sideLabelOrientation"),
  );
  // trmx-90: the badge watermark COLOR, seeded from the active theme's `terminal.badge` token and
  // kept live over settings:changed. Tracking the RESOLVED COLOR (not just the theme id, review-1) is
  // load-bearing: the trmx-89 hot-reload re-emits appearance.theme with the SAME user-theme id after
  // re-registering updated tokens, so keying on the id would no-op setState and leave the badge on a
  // stale color while the terminal repaints. resolveTheme is total, so any id resolves to a color.
  const [badgeColor, setBadgeColor] = useState<string>(
    () => resolveTheme(makeSettingsStore().get("appearance.theme")).terminal.badge,
  );
  // trmx-149: the badge's glyph-edge STROKE color — the active theme's background (bg.primary),
  // iTerm2's edge treatment so the watermark separates from same-tint glyphs beneath it. Tracked as
  // RESOLVED state exactly like badgeColor (same same-id hot-reload staleness trap, review-1).
  const [badgeOutlineColor, setBadgeOutlineColor] = useState<string>(
    () => resolveTheme(makeSettingsStore().get("appearance.theme")).color.bg.primary,
  );
  // trmx-91: whether the per-pane activity line is enabled (terminal.activityIndicator, default true),
  // seeded from the shared settings snapshot and kept live over settings:changed. When off, the line
  // never renders (App gates it) though the backend poller keeps running for titles.
  const [activityIndicatorOn, setActivityIndicatorOn] = useState<boolean>(() =>
    makeSettingsStore().get("terminal.activityIndicator"),
  );
  // trmx-151: whether the tab strip prefixes the first nine titles with their ⌘N select-chord
  // (tabs.showShortcutHints, default true), seeded from the shared settings snapshot and kept
  // live over settings:changed — the exact activityIndicatorOn pattern. A pure render gate: the
  // keymap (and the chords it binds) is untouched by the toggle.
  const [shortcutHintsOn, setShortcutHintsOn] = useState<boolean>(() =>
    makeSettingsStore().get("tabs.showShortcutHints"),
  );
  // trmx-190: whether the title bar shows the AI-session counter (titleBar.aiCounter, default
  // true) — the exact activityIndicatorOn pattern; a pure render gate over the counting state.
  const [aiCounterOn, setAiCounterOn] = useState<boolean>(() =>
    makeSettingsStore().get("titleBar.aiCounter"),
  );
  // trmx-160: the active theme's MODE — the busy progress bar keys its track color + sweep period on
  // it (dark: black track / 3s; light: white track / 6s). Tracked as RESOLVED state and re-derived on
  // every theme event (a trmx-89 same-id hot-reload can flip isDark under the same id), exactly like
  // the badge color. resolveTheme is total, so any id resolves.
  const [activityIsDark, setActivityIsDark] = useState<boolean>(() =>
    activityIsDarkFor(makeSettingsStore().get("appearance.theme")),
  );
  // trmx-99 (FR-7b): the exit-code flash color (semantic.error at the same alpha) + the set of panes
  // currently flashing after a failed command. The flashing set drives the overlay re-render.
  const [activityErrorColor, setActivityErrorColor] = useState<string>(() =>
    activityErrorColorFor(makeSettingsStore().get("appearance.theme")),
  );
  const [flashingPanes, setFlashingPanes] = useState<Set<PaneId>>(() => new Set());
  // trmx-90: the pane whose badge is being edited via the ⇧⌘B inline editor (null = not editing).
  // Mirrors renamingTabId: while non-null, focus-follows-activation is SUPPRESSED (the input owns
  // the keyboard); commit/cancel clears it, handing focus back to the pane's terminal.
  const [badgingPaneId, setBadgingPaneId] = useState<PaneId | null>(null);
  // trmx-98 (FR-1.5): the set of panes with an OPEN find bar (per-pane isolation — two in a split).
  // Like badgingPaneId, an open bar SUPPRESSES focus-follows for its pane (the input owns the keyboard).
  const [openSearchPanes, setOpenSearchPanes] = useState<Set<PaneId>>(() => new Set());
  // trmx-98: live search-highlight colors (theme tokens) fed to the addon decorations.
  const [searchColors, setSearchColors] = useState(
    () => resolveTheme(makeSettingsStore().get("appearance.theme")).terminal.search,
  );
  // trmx-93 (FR-5): which surface a "…with Script…" verb requested (null = the picker is closed).
  // Opening the picker; on run it creates that surface with the chosen script pending; Esc cancels.
  const [scriptPickerRequest, setScriptPickerRequest] = useState<"tab" | "right" | "below" | null>(
    null,
  );
  // trmx-94 (FR-9.2): the ⇧⌘P command palette open state.
  const [showPalette, setShowPalette] = useState(false);
  // trmx-144: the pending confirm-before-close dialog (null = none). State drives the render; the
  // mirror ref below is the out-of-render read for the close gates + the capture-phase keydown.
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
  // trmx-94 (FR-9.3): the effective keymap (defaults ⊕ user [keys]). Seeded to the shipped defaults
  // SYNCHRONOUSLY so keyboard shortcuts work on the first paint; the async keys_read + keys:changed
  // rebuild it with the user's overrides.
  const [keymap, setKeymap] = useState<Record<string, string>>(
    () => mergeKeymap(FULL_DEFAULT_KEYS, []).keymap,
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
  // trmx-224: the service-delivery entry point and the tab-creation primitive, ref-indirected
  // because the boot effect is defined above the creators it composes; assigned every render
  // right after their definitions.
  const deliverServicePathsRef = useRef<(paths: string[]) => void>(() => {});
  // trmx-225: focus-follows-mouse — the live setting mirror (updated over settings:changed),
  // the last observed pointer position (the real-movement guard: reflow under a stationary
  // cursor re-targets elements without motion and must never refocus), and a ref mirror of
  // the script-picker overlay for the synchronous suspension check.
  const ffmRef = useRef<boolean>(makeSettingsStore().get("terminal.focusFollowsMouse"));
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const scriptPickerRef = useRef<"tab" | "right" | "below" | null>(null);
  const createTabRef = useRef<(cwdOverride?: string) => { tabId: number; paneId: number }>(
    () => ({ tabId: 0, paneId: 0 }),
  );
  const startupFiredRef = useRef(false); // trmx-93: the startup script fires at most once
  const renamingRef = useRef(renamingTabId); // out-of-render read for the onReady focus guard
  const badgingRef = useRef(badgingPaneId); // out-of-render read for the onReady focus guard (trmx-90)
  // trmx-248 (grill H6): ONE record per pane, replacing the fifteen parallel per-pane Maps/Sets
  // this component used to carry. `paneRuntime.ts` owns the teardown contract; App keeps the two
  // halves a ref cannot own — the React state removals and the backend close.
  const runtimesRef = useRef(createPaneRuntimes());
  // Get-or-create. `makeCwdStore()` is built only on the miss: `paneOf` is called several times per
  // pane on every render (the callback caches, `storeFor`), and eagerly passing a fresh store to
  // `ensure` allocated one plus its closures per call just to throw it away.
  const paneOf = (paneId: PaneId): PaneRuntime =>
    runtimesRef.current.get(paneId) ?? runtimesRef.current.ensure(paneId, makeCwdStore());

  // Update an EXISTING record; a write for an unknown pane is dropped.
  //
  // Deliberately non-creating. Most of the writes this replaced were `Map.delete(paneId)` clears —
  // deregistering a find bar, dropping a pending script for a pane that closed mid-attach — and a
  // creating writer turns each of those into a resurrection: closing a pane with an open FindBar
  // disposes its record, then FindBar cleanup calls `onRegister(null)` and immediately rebuilds an
  // empty one. Nothing ever removes it, so every closed pane leaks a record. Panes that are alive
  // always have a record already (`readyFor`/`storeFor` create it at render), so dropping the write
  // costs nothing. The genuine before-first-render writes use `seedPaneField`.
  const setPaneField = <K extends keyof PaneRuntime>(
    paneId: PaneId,
    field: K,
    value: PaneRuntime[K],
  ) => {
    const runtime = runtimesRef.current.get(paneId);
    if (runtime) runtime[field] = value;
  };

  // Create-if-absent, then write. For the four writes aimed at a pane that has NOT rendered yet:
  // `pendingCwd` and `pendingScript` are both stored against the id of a pane that is about to be
  // opened. Routing these through `setPaneField` silently drops them — it typechecks and the
  // startup script simply never sources.
  const seedPaneField = <K extends keyof PaneRuntime>(
    paneId: PaneId,
    field: K,
    value: PaneRuntime[K],
  ) => {
    paneOf(paneId)[field] = value;
  };

  const openSearchRef = useRef(openSearchPanes); // out-of-render read for the onReady focus guard (trmx-98)
  // trmx-144: pendingClose's mirror (the gates and the keydown handler run out-of-render), kept in
  // sync by setPendingCloseSynced; and whether a quit is already authorized — set the moment a gated
  // (or bypassed) gesture reaches closeWindow, so the backend's close:requested round-trip for that
  // very gesture never prompts a second time.
  const pendingCloseRef = useRef<PendingClose | null>(null);
  const quitAuthorizedRef = useRef(false);
  const bootedRef = useRef(false);

  // Latest-seam ref: the cached per-pane callbacks (stable identity — an inline arrow would remount
  // the terminal via TerminalView's effect deps) read the CURRENT seams through it.
  const seamsRef = useRef({
    attach: attachFn,
    closeWindow,
    quitConfirmed,
    closeAcknowledged,
    closeSession,
    setWindowTitle,
    sendInput,
  });
  seamsRef.current = {
    attach: attachFn,
    closeWindow,
    quitConfirmed,
    closeAcknowledged,
    closeSession,
    setWindowTitle,
    sendInput,
  };
  boundsRef.current = bounds;
  renamingRef.current = renamingTabId;
  badgingRef.current = badgingPaneId;
  openSearchRef.current = openSearchPanes;
  scriptPickerRef.current = scriptPickerRequest; // trmx-225: FFM suspension reads it per event

  // Keep stateRef pointed at the latest COMMITTED state for the out-of-render callbacks (attach
  // resolutions, event subscriptions) — an effect, not a render assignment, so a discarded render
  // never leaves it pointing at uncommitted state (the trmx-74 pattern).
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // trmx-94 (FR-9.3): load the user [keys] overrides + rebuild the effective keymap; re-read on a
  // keys:changed watcher signal (live rebind). Inert without a Tauri runtime (readKeys resolves {}).
  useEffect(() => {
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
  }, [invoke]);

  // Boot: exactly ONE initial tab (one pane). The ref guards StrictMode's double effect-invocation.
  // trmx-93 (FR-5): if a startup script is configured, attach it to the first pane BEFORE dispatching
  // openTab — its promise is stored in pendingScriptRef keyed by the upcoming nextPaneId, and the
  // attach send-step awaits it, so the async listScripts resolution never loses the race (finding 3).
  // Smoke/perf are already excluded: main.tsx boot() returns before App renders on those launches.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (stateRef.current.tabs.length === 0) {
      // trmx-224: a service-triggered cold launch (main.tsx pre-fetched the queued dirs
      // BEFORE mount) opens the requested dirs as the initial tabs — no default $HOME tab,
      // no startup script. Plain boot (the empty default) is byte-identical to before.
      if (serviceBootPaths.length > 0) {
        deliverServicePathsRef.current(serviceBootPaths);
        return;
      }
      const startupPath = makeSettingsStore().get("scripts.startup");
      // The boot default tab goes through the shared creation primitive (one reservation
      // per dispatch; at boot there is no active tab, so the inherited cwd is undefined —
      // identical to the pre-trmx-224 unseeded open), and the startup script keys off the
      // RETURNED pane id like every other wrapper.
      const opened = createTabRef.current();
      if (startupPath && !startupFiredRef.current) {
        startupFiredRef.current = true;
        seedPaneField(
          opened.paneId, "pendingScript", listScripts(invoke).then((scripts) => {
            const match = scripts.find((entry) => entry.relPath === startupPath);
            if (!match) {
              log.warn(
                `startup script "${startupPath}" not found in ~/.config/termixion/scripts/; starting a plain shell`,
              );
              return null;
            }
            return { sourceLine: match.sourceLine };
          }),
        );
      }
    }
  }, [invoke]);

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
  // trmx-254 (T3a): the per-pane callback caches. Pure logic — the root still owns every ref and
  // every piece of state; the hook is handed exactly what the compiler says it reads.
  const { storeFor, readyFor, oscTitleFor, badgeFor, focusFocusedPane } = usePaneCallbacks({
    paneOf, setPaneField, runtimesRef, seamsRef, dispatch, stateRef,
    renamingRef, badgingRef, openSearchRef,
  });
  // trmx-254 (T3b): the activity concern. E07/E08 and E05's title-hint subscription keep their
  // registrations and dependency arrays at the root; only their bodies live here.
  const activity = usePaneActivity({
    paneOf, setPaneField, runtimesRef, ioObserversRef, stateRef, dispatch,
    setFlashingPanes, observeActivity, observeOutput, observeInput, observeTitleHint,
  });
  const { applyActivityTransition, clearFlashFor, promptMarkerFor } = activity;
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
      if (shouldConfirmClose(makeSettingsStore().get("terminal.confirmClose"), report.busy, "user")) {
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
      if (shouldConfirmClose(makeSettingsStore().get("terminal.confirmClose"), busy, "user")) {
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
  const createTab = (cwdOverride?: string): { tabId: number; paneId: number } => {
    const s = stateRef.current;
    const { tabId, paneId } = reservation.reserveTab();
    const activeTab =
      s.activeTabId !== null ? s.tabs.find((t) => t.tabId === s.activeTabId) : undefined;
    const activeStore = activeTab ? runtimesRef.current.get(activeTab.focusedPaneId)?.cwd : undefined;
    seedPaneField(paneId, "pendingCwd", cwdOverride ?? activeStore?.get() ?? undefined);
    dispatch({ kind: "openTab" });
    return { tabId, paneId };
  };
  createTabRef.current = createTab;
  // The public creator stays PARAMETERLESS: it is wired as an event handler (the tab strip's
  // "+" onClick), and a parameter would receive the click event (trmx-224 regression).
  const requestNewTab = () => createTab();

  // trmx-84: split the active tab's focused pane. `right` → a row split (side by side), `below` → a
  // column split (stacked). Refused (soft no-op) when the result would go below the min pane size.
  // The new pane inherits the focused pane's cwd and takes focus (readyFor focuses it on mount).
  const requestSplit = (dir: "right" | "below"): { paneId: number } | null => {
    const s = stateRef.current;
    if (s.activeTabId === null) return null;
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId);
    if (!tab) return null;
    const treeDir: SplitDir = dir === "right" ? "row" : "column";
    if (!canSplitFocused(tab, treeDir, boundsRef.current, MIN_PANE_PX)) return null; // won't fit — no-op
    // trmx-224: reserve AFTER the refusal checks — a refused split reserves nothing (the
    // 1:1 reservation-per-dispatch pairing; splitPane advances only the pane counter).
    const { paneId } = reservation.reservePane();
    const focusedStore = runtimesRef.current.get(tab.focusedPaneId)?.cwd;
    seedPaneField(paneId, "pendingCwd", focusedStore?.get() ?? undefined);
    dispatch({ kind: "splitPane", tabId: tab.tabId, dir: treeDir });
    return { paneId };
  };

  // trmx-93 (FR-5): run `entry` in a fresh surface. The chosen script is stored in pendingScriptRef
  // keyed by the upcoming pane's (predictable) id SYNCHRONOUSLY before the creating dispatch — the
  // same nextPaneId requestNewTab/requestSplit seed pendingCwdRef with, so cwd inheritance survives
  // and the new pane's attach sources the script. For a split that won't fit we bail WITHOUT setting
  // the pending script, so a no-op split can't leave a stale entry for the next pane to pick up.
  const runScriptInSurface = (entry: ScriptEntry, surface: "tab" | "right" | "below") => {
    // trmx-224: creators return their RESERVED ids — the wrapper never predicts (a delegating
    // read would double-reserve). Keying happens right after the call, in the same synchronous
    // section, well before any attach; a refused split returns null and nothing is keyed, so
    // the old bail-before-set stale-entry dance is now structural.
    const pending = Promise.resolve<{ sourceLine: string } | null>({ sourceLine: entry.sourceLine });
    const opened = surface === "tab" ? requestNewTab() : requestSplit(surface);
    if (opened) seedPaneField(opened.paneId, "pendingScript", pending);
  };

  // trmx-224: deliver one service batch — ONE synchronous block (reserve→seed→dispatch per
  // path via requestNewTab), then focus the FIRST delivered tab (each openTab activates the
  // appended tab, so without this the LAST path would win). Any `await` inside this block
  // would reopen the prediction-interleaving race class — keep it unbroken.
  const deliverServicePaths = (paths: string[]) => {
    let firstTabId: number | null = null;
    for (const path of paths) {
      const opened = createTab(path);
      if (firstTabId === null) firstTabId = opened.tabId;
    }
    if (firstTabId !== null) dispatch({ kind: "activateTab", tabId: firstTabId });
  };
  deliverServicePathsRef.current = deliverServicePaths;

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

  // ⌘W / menu "close": close the active tab's FOCUSED pane (pane → tab → window). `origin`
  // (trmx-144) tags who asked — the dispatcher injects "remote" for control-channel requests, so
  // those skip the confirm gate; everything else defaults to "user".
  const requestCloseActive = (origin?: "user" | "remote") => {
    const s = stateRef.current;
    if (s.activeTabId === null) return;
    const tab = s.tabs.find((t) => t.tabId === s.activeTabId);
    if (!tab) return;
    closePaneInternal(tab.tabId, tab.focusedPaneId, { origin: origin ?? "user" });
  };

  // The tab-strip × closes the WHOLE tab (all its panes), distinct from the ⌘W pane precedence.
  const requestCloseTab = (tabId: number) => closeTabInternal(tabId);

  // trmx-94 (FR-9.1): the command platform. The CommandContext maps each command's `run` onto the
  // existing request* funcs + a few new capabilities; menu verbs, keymap hits, and palette picks ALL
  // route through `dispatch` (the single spine). The dispatcher is created ONCE (MRU persists) with a
  // forwarding ctx that always calls the CURRENT request funcs via a ref.
  const getActiveTab = () => {
    const s = stateRef.current;
    return s.activeTabId !== null ? s.tabs.find((t) => t.tabId === s.activeTabId) : undefined;
  };
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
  const commandCtxRef = useRef(commandCtx);
  commandCtxRef.current = commandCtx;
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;
  const dispatcherRef = useRef<Dispatcher | null>(null);
  if (dispatcherRef.current === null) {
    // Forward every command-ctx call to the CURRENT implementation (which reads fresh state/refs).
    const forwarding = new Proxy({} as CommandContext, {
      get(_target, prop: string) {
        return (...args: unknown[]) =>
          (commandCtxRef.current as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](
            ...args,
          );
      },
    });
    dispatcherRef.current = createDispatcher(buildCommands(), forwarding);
  }
  const commandsRef = useRef<Command[]>(buildCommands());

  // trmx-94: the menu verb → command-id map. Menu clicks (and the trmx-74/84/86/90/93 verbs) route
  // through `dispatch` so every action goes through the one spine (FR-9.1).
  const VERB_TO_COMMAND: Record<string, string> = {
    new: "tab.new",
    close: "pane.close", // the ⌘W "Close Tab" menu item closes the focused pane (pane precedence)
    next: "tab.next",
    prev: "tab.prev",
    "split-right": "pane.split-right",
    "split-below": "pane.split-below",
    "new-with-script": "tab.new-with-script",
    "split-right-with-script": "pane.split-right-with-script",
    "split-below-with-script": "pane.split-below-with-script",
    "pane-left": "pane.focus-left",
    "pane-right": "pane.focus-right",
    "pane-up": "pane.focus-up",
    "pane-down": "pane.focus-down",
    "pane-next": "pane.next",
    "pane-prev": "pane.prev",
    rename: "tab.rename",
    "set-badge": "pane.set-badge",
    palette: "app.command-palette",
    "clear-scrollback": "terminal.clear-scrollback",
    // trmx-94 (review finding 7): Settings + Close Window route through dispatch too (not the Rust
    // ShowSettings/CloseMainWindow shortcuts), so every command-backed menu action is on the spine.
    "app-settings": "app.settings",
    "window-close": "window.close",
  };

  // trmx-75/166: the rename intents. Start = activate + flip into rename; commit sets the TAB's
  // manual title PIN (empty → clear-to-auto); cancel drops the edit. Commit/cancel clearing
  // `renamingTabId` re-runs the focus effect, handing the keyboard back to the focused pane.
  const startRename = (tabId: number) => {
    dispatch({ kind: "activateTab", tabId });
    setRenamingTabId(tabId);
  };
  const commitRename = (tabId: number, value: string) => {
    // trmx-166: the rename is a TAB-scoped pin (setTabTitle), not a per-pane manual source — so it
    // survives pane splits and focus changes. The reducer no-ops on an unknown tab.
    dispatch({ kind: "setTabTitle", tabId, value: value.trim() === "" ? null : value });
    setRenamingTabId(null);
  };
  const cancelRename = () => setRenamingTabId(null);

  // trmx-90: the ⇧⌘B badge editor intents. Commit writes the FOCUSED pane's badge (empty/whitespace →
  // clear to null); cancel (Esc/blur) drops the edit with no dispatch. Clearing badgingPaneId re-runs
  // the focus effect, handing the keyboard back to that pane's terminal. The tab is found by paneId
  // (global-unique) so a commit lands on the right pane even if focus/activation moved meanwhile.
  const commitBadge = (paneId: PaneId, value: string) => {
    const tab = stateRef.current.tabs.find((t) => t.panes[paneId] !== undefined);
    if (tab) {
      dispatch({
        kind: "setBadge",
        tabId: tab.tabId,
        paneId,
        badge: value.trim() === "" ? null : value,
      });
    }
    setBadgingPaneId(null);
  };
  const cancelBadge = () => setBadgingPaneId(null);

  // Subscriptions: pty:exited (a pane's shell exited → close just that pane), session:title-hint
  // (route by sessionId into the owning PANE's `process` slot), and the menu's tabs:action intents.
  useEffect(() => {
    const stopExited = observePtyExited((sessionId) => {
      const hit = paneBySessionId(stateRef.current, sessionId);
      if (hit) closePaneInternal(hit.tab.tabId, hit.paneId, { alreadyExited: true });
    });
    const stopTitleHints = activity.onTitleHint();
    const stopTabsAction = observeTabsAction((payload) => {
      // trmx-268: the close verb now arrives as {action, gen} so the ack can echo the generation.
      // Every OTHER verb keeps its plain-string payload and the validation below — the widening is
      // strictly additive. The ack fires BEFORE the pending-dialog early return, because a webview
      // showing a dialog is alive and must not look hung to the backend.
      if (typeof payload === "object" && payload !== null) {
        const ask = payload as { action?: unknown; gen?: unknown };
        if (ask.action !== "window-close" || !isAskGeneration(ask.gen)) return;
        const generation = ask.gen;
        // The dispatch is chained onto the ack's COMPLETION, not merely ordered after its call:
        // starting the close before the backend has recorded liveness is the race that would let a
        // slow-but-alive webview be torn down on the next gesture.
        void seamsRef.current.closeAcknowledged(generation).then(() => {
          if (pendingCloseRef.current !== null) return;
          const commandId = VERB_TO_COMMAND["window-close"];
          if (commandId) dispatcherRef.current?.dispatch(commandId);
        });
        return;
      }
      // trmx-94 (FR-9.1): menu verbs are untrusted input — map the exact verb string to a command id
      // and route it through the single `dispatch` spine (junk / unknown verbs are inert).
      if (typeof payload !== "string") return;
      // trmx-144: the confirm dialog is modal for the NATIVE menu path too — packaged accelerators
      // (⌘T etc.) arrive here as tabs:action events, not DOM keydowns the keymap gate would catch.
      if (pendingCloseRef.current !== null) return;
      const commandId = VERB_TO_COMMAND[payload];
      if (commandId) dispatcherRef.current?.dispatch(commandId);
    });
    return () => {
      stopExited();
      stopTitleHints();
      stopTabsAction();
    };
  }, [observePtyExited, observeTitleHint, observeTabsAction]);

  // trmx-224: running-app service delivery. Every nudge — and the registration-completion
  // drain the observer fires itself — drains the backend queue. Concurrent drains are
  // harmless (the take is atomic: one drain gets the batch, the rest see empty), and
  // delivery during a pending close-confirm simply appends behind the dialog (the v1
  // contract; PTY exits already mutate tab state during modals by design).
  useEffect(() => {
    return observeServiceNudge(() => {
      void takePendingOpenPaths(invoke).then((paths) => {
        if (paths.length > 0) deliverServicePathsRef.current(paths);
      });
    });
  }, [observeServiceNudge, invoke]);

  // trmx-91: subscribe to session:activity — route each busy<->idle transition by sessionId into the
  // OWNING pane (the per-pane closure is the load-bearing scoping: a background pane's busy state
  // shows on THAT pane's line, never the focused one) and drive its debounce. Its OWN effect, dep'd
  // only on the stable seam. Independent of the setting: the debounce always runs; the render gate
  // (activityIndicatorOn) alone decides whether the resolved line paints, so toggling the setting
  // never desyncs the phase.
  useEffect(() => {
    return activity.onSessionActivity();
  }, [observeActivity]);

  // trmx-159: the test-only I/O injection seams (production observes through useBackend directly).
  // Each drives the same ioObserversRef handlers as the live terminal wiring.
  useEffect(() => {
    return activity.installIoObservers();
  }, [observeOutput, observeInput]);

  // trmx-101 (FR-9.4): the control-channel bridge. A request from the Rust socket routes through the SAME
  // command dispatcher as a keypress, builds the ls snapshot, or types into a pane; the reply goes back
  // via control_response. All App-owned state read from refs (out-of-render).
  // trmx-237 (grill H4): the backend's per-session notices — today, a working directory it could not
  // honor. Routed to the owning pane's terminal, which is the surface the user is already looking at
  // when the thing goes wrong. A notice for an unknown session (closed in the meantime) is dropped.
  useEffect(() => {
    return observeSessionNotice(({ session_id, text }) => {
      const hit = paneBySessionId(stateRef.current, session_id);
      if (!hit) return;
      const handle = runtimesRef.current.get(hit.paneId)?.handle;
      if (handle) writePaneNotice(handle, text);
    });
  }, [observeSessionNotice]);

  useEffect(() => {
    const paneBusy = (paneId: PaneId): boolean => {
      for (const tab of stateRef.current.tabs) {
        const pane = tab.panes[paneId];
        if (pane) return pane.activityVisible === true;
      }
      return false;
    };
    return observeControlRequest(({ id, request }) => {
      const deps: ControlDeps = {
        // trmx-144: forward the router's "remote" source so close commands skip the confirm gate.
        dispatch: (cmd, arg, source) => dispatcherRef.current?.dispatch(cmd, arg, source) ?? false,
        hasCommand: (cmd) => dispatcherRef.current?.get(cmd) !== undefined,
        // trmx-235: the `commands` query lists every registry id (the documented callable set).
        listCommands: () => commandsRef.current.map((c) => c.id),
        buildLs: () =>
          buildLsSnapshot(
            stateRef.current.tabs,
            stateRef.current.activeTabId,
            (paneId) => runtimesRef.current.get(paneId)?.cwd?.get() ?? null,
            paneBusy,
          ),
        sendText: (pane, text) => {
          const active = getActiveTab();
          const paneId = pane === "focused" ? active?.focusedPaneId : Number(pane);
          if (paneId === undefined || Number.isNaN(paneId)) return false;
          const sessionId = runtimesRef.current.get(paneId)?.sessionId;
          if (sessionId === undefined) return false;
          seamsRef.current.sendInput(sessionId, text).catch(() => {});
          return true;
        },
      };
      const payload = routeControlRequest(request, deps);
      invoke("control_response", { id, payload }).catch(() => {});
    });
  }, [observeControlRequest, invoke]);

  // trmx-144: the quit gate. The backend intercepts the native window close (red button / ⌘Q) and
  // round-trips it as close:requested; the webview answers with quit_confirmed once authorized. An
  // already-authorized quit (a gated gesture reached the last-tab closeWindow, or a prior quit
  // confirm) goes straight back; an open dialog swallows the repeat; otherwise gate on the all-tabs
  // busy report (per terminal.confirmClose, read fresh).
  useEffect(() => {
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
        if (shouldConfirmClose(makeSettingsStore().get("terminal.confirmClose"), report.busy, "user")) {
          setPendingCloseSynced({ kind: "quit", names: report.names, busyTabCount: report.busyTabCount });
        } else {
          seamsRef.current.quitConfirmed();
        }
      });
    });
  }, [observeCloseRequested]);

  // trmx-144: the dialog's resolutions. Confirm re-enters the SAME close path with {confirmed:true},
  // re-resolving the target by id first — a pane/tab that died while the dialog was up makes confirm
  // a safe no-op (never a wrong-target close). "Don't ask again" persists the setting before closing.
  const confirmPendingClose = (dontAskAgain: boolean) => {
    const pending = pendingCloseRef.current;
    if (pending === null) return;
    if (dontAskAgain) makeSettingsStore().set("terminal.confirmClose", "never");
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
      // trmx-91: keep the activity-indicator toggle live (boolean-guarded, the untrusted-payload
      // discipline). Off hides the line without touching the backend poller (titles keep flowing).
      // trmx-225: keep the FFM gate live — a ref (not state): the hover handler reads it per
      // event and nothing needs a re-render on toggle.
      else if (key === "terminal.focusFollowsMouse" && typeof value === "boolean") {
        ffmRef.current = value;
      } else if (key === "terminal.activityIndicator" && typeof value === "boolean") {
        setActivityIndicatorOn(value);
      }
      // trmx-151: keep the ⌘N hint toggle live (same boolean guard). Off strips the prefixes
      // without touching the keymap — the chords stay bound either way.
      else if (key === "tabs.showShortcutHints" && typeof value === "boolean") {
        setShortcutHintsOn(value);
      }
      // trmx-190: keep the AI-session-counter toggle live (same boolean guard). A pure render
      // gate — foreground tracking keeps running so re-enabling shows correct counts at once.
      else if (key === "titleBar.aiCounter" && typeof value === "boolean") {
        setAiCounterOn(value);
      }
      // trmx-90/91: recompute the badge watermark AND the activity-line color on every theme event so
      // both repaint on a theme switch AND on a trmx-89 same-id hot-reload (the token changed under the
      // same id, review-1). Same untrusted-payload discipline as barPosition; resolveTheme is total.
      else if (key === "appearance.theme") {
        // trmx-202: a REMOVED built-in (live config edit / the watcher's default "white")
        // normalizes to the derived default before the guard; user-shape ids pass untouched.
        const themeId = normalizeLegacyThemeId(value) ?? value;
        if (isRegisteredThemeId(themeId) || isUserThemeIdShape(themeId)) {
          // trmx-173: re-apply the --tx-* CSS vars on documentElement so the main window's chrome (tab
          // bar, borders, …) recolors with the terminal. On EVERY theme event — including a trmx-89
          // same-id hot-reload where the tokens changed under the same id — matching the color-state
          // refreshes below; applyTxTheme is idempotent, so a bus echo is harmless.
          applyTxTheme(themeId, document);
          setBadgeColor(resolveTheme(themeId).terminal.badge);
          setBadgeOutlineColor(resolveTheme(themeId).color.bg.primary); // trmx-149: re-tint the stroke
          setActivityIsDark(activityIsDarkFor(themeId)); // trmx-160: re-key the progress bar's mode
          setActivityErrorColor(activityErrorColorFor(themeId)); // trmx-99: re-tint the exit-code flash
          setSearchColors(resolveTheme(themeId).terminal.search); // trmx-98: re-tint the find highlights
        }
      }
    });
    return stopSettings;
  }, [observeSettings]);

  // trmx-89 (FR-6): the main window owns the theme HOT-RELOAD machine. A `themes:changed` signal
  // re-hydrates the user-theme registry and, per decideHotReload, reapplies the active user theme
  // (re-emitting settings:changed so TerminalView repaints with its fresh tokens), falls back to the
  // derived default when its file was deleted, or warns when it became invalid (keeping the previous
  // colors). Installed ONCE; the returned unsubscribe tears the subscription down on unmount — the
  // live-guard / teardown-safe / no-runtime discipline lives inside onThemesChanged, so this is inert
  // without a Tauri runtime. The store carries the real bus so a fallback's settings.set broadcasts
  // settings:changed to the live terminals (source "themes-reload").
  useEffect(() => {
    return installHotReload({
      settings: makeSettingsStore(undefined, realEventBus, "themes-reload"),
    });
  }, [installHotReload]);

  // ⌘1..⌘9 select a tab; ⌘D / ⇧⌘D split (trmx-84); ⌥⌘-arrows / ⌘]/⌘[ navigate panes (trmx-86). Capture
  // phase on window so the chord wins even while xterm's helper textarea has focus; tabKeymap vetoes
  // non-terminal editables and foreign chords, so nothing else is intercepted.
  useEffect(() => {
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
  }, []);

  // Focus follows activation / focus change: the active tab's FOCUSED pane's terminal takes the
  // keyboard. SUPPRESSED while a rename is in flight (the input keeps focus). Re-runs when the active
  // tab OR its focused pane changes (click-to-focus a sibling pane).
  const activeTab = state.tabs.find((t) => t.tabId === state.activeTabId);
  const activeFocusedPaneId = activeTab?.focusedPaneId ?? null;
  useEffect(() => {
    focusFocusedPane(activeFocusedPaneId);
  }, [state.activeTabId, activeFocusedPaneId, renamingTabId, badgingPaneId, openSearchPanes]);

  // trmx-75/166: the NATIVE window title is the ACTIVE tab's title — the manual pin when set, else
  // the focused pane's effective title (Tab.title / deriveTitle). Background tabs/panes never reach
  // it. Undefined = no tabs yet (boot) — leave the window alone.
  const activeTitle = activeTab?.title;
  useEffect(() => {
    if (activeTitle === undefined) return;
    seamsRef.current.setWindowTitle(activeTitle);
  }, [activeTitle]);

  // trmx-243 (grill L6): the core title mirror used to live here — every attached pane's effective
  // title was written into its core session over an IPC per change, and nothing ever read it back
  // (`SessionRegistry::title()` had no production caller; the control protocol's `ls` snapshot is
  // built frontend-side in controlBridge.ts). Titles are frontend state, full stop.
  //
  // trmx-166 still holds and is still tested: a tab's manual rename is a TAB-scoped PIN
  // (Tab.manualTitle) driving the tab label and the native window title (activeTab.title, above)
  // ONLY. A process/OSC hint on a pane under a pinned tab updates that PANE's own title while the
  // tab LABEL stays pinned.

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

  // Cleanup on unmount: a mid-drag unmount must not leave a queued frame to dispatch into a dead
  // reducer, and (trmx-91/99) no pending activity OR flash timer may fire a setState after unmount.
  useEffect(() => {
    const runtimes = runtimesRef.current;
    return () => {
      if (frameCancelRef.current) frameCancelRef.current();
      // trmx-248: timers ONLY — StrictMode replays this cleanup while the App is still mounted, so
      // dropping records here would wipe pending cwd, callbacks, sessions and attach epochs.
      runtimes.clearAllTimers();
    };
  }, []);

  // trmx-100 (FR-3.4): ⌘-drag a pane to re-dock it. Modeled on the divider drag: ephemeral state in refs
  // + two useState (the shield + the drop preview). Capture-phase so an over-slop move is intercepted
  // BEFORE xterm starts a selection/link click; a sub-slop ⌘-press falls through so a plain ⌘-click still
  // opens a link. `endPaneDrag` is the SINGLE termination path (pointerup / Esc / outside / pointercancel /
  // lostpointercapture / unmount), clearing the pending frame + preview + shield.
  const PANE_DRAG_SLOP = 4;
  const [paneDragging, setPaneDragging] = useState(false);
  const [dropPreview, setDropPreview] = useState<{ paneId: PaneId; zone: DropZone } | null>(null);
  const pickupRef = useRef<{
    pointerId: number;
    tabId: number;
    paneId: PaneId;
    originX: number;
    originY: number;
    active: boolean;
  } | null>(null);
  const paneDragFrameRef = useRef<(() => void) | null>(null);
  const pendingPointerRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);

  // Which pane + zone the pointer is over (content-relative coords, solveRects space). Null when outside
  // any pane, over the SOURCE pane itself, or on an edge whose 50/50 insert would under-size a pane.
  const computeDropTarget = (clientX: number, clientY: number): { paneId: PaneId; zone: DropZone } | null => {
    const p = pickupRef.current;
    if (!p) return null;
    const tab = stateRef.current.tabs.find((t) => t.tabId === p.tabId);
    if (!tab) return null;
    const contentRect = contentRef.current?.getBoundingClientRect();
    const cx = clientX - (contentRect?.left ?? 0);
    const cy = clientY - (contentRect?.top ?? 0);
    const solved = solveRects(tab.tree, boundsRef.current);
    const hit = solved.panes.find(
      (pr) =>
        cx >= pr.rect.x &&
        cx < pr.rect.x + pr.rect.width &&
        cy >= pr.rect.y &&
        cy < pr.rect.y + pr.rect.height,
    );
    if (!hit || hit.paneId === p.paneId) return null; // outside, or the source pane itself
    const zone = dropZone(hit.rect, { x: cx, y: cy });
    if (zone !== "center" && !canDropEdge(tab.tree, hit.paneId, zone, boundsRef.current)) return null;
    return { paneId: hit.paneId, zone };
  };

  const schedulePaneHoverFlush = () => {
    if (paneDragFrameRef.current) return; // coalesce into the pending frame
    paneDragFrameRef.current = dragScheduleRef.current(() => {
      paneDragFrameRef.current = null;
      const pt = pendingPointerRef.current;
      if (pt) setDropPreview(computeDropTarget(pt.x, pt.y));
    });
  };

  const endPaneDrag = (commit: boolean, target?: { paneId: PaneId; zone: DropZone } | null) => {
    const p = pickupRef.current;
    if (paneDragFrameRef.current) {
      paneDragFrameRef.current();
      paneDragFrameRef.current = null;
    }
    if (commit && p && target) {
      dispatch({
        kind: "redockPane",
        tabId: p.tabId,
        paneId: p.paneId,
        targetPaneId: target.paneId,
        zone: target.zone,
      });
    }
    // An abort path (pointercancel / lostpointercapture / Esc / unmount) produces NO trailing click, so the
    // click-swallow must be disarmed here or it would eat the next unrelated pane click. On a `commit`
    // (pointerup) the synthetic click DOES follow and onPaneClickCapture clears the flag itself.
    if (!commit) suppressClickRef.current = false;
    pickupRef.current = null;
    pendingPointerRef.current = null;
    setDropPreview(null);
    setPaneDragging(false);
  };

  const onPanePointerDownCapture = (tabId: number, paneId: PaneId) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || !e.metaKey) return; // only ⌘ + primary starts a pickup candidate
    suppressClickRef.current = false; // clear any stale swallow from a prior gesture that never clicked
    // Record the origin but do NOT preventDefault yet — a sub-slop ⌘-click must still open an OSC 8 link.
    pickupRef.current = { pointerId: e.pointerId, tabId, paneId, originX: e.clientX, originY: e.clientY, active: false };
  };

  const onPanePointerMoveCapture = (e: ReactPointerEvent) => {
    const p = pickupRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    if (!p.active) {
      if (Math.abs(e.clientX - p.originX) < PANE_DRAG_SLOP && Math.abs(e.clientY - p.originY) < PANE_DRAG_SLOP) {
        return; // still under the slop threshold — could be a click
      }
      // Crossed slop → commit to a pickup: capture the pointer, raise the shield, drop any nascent xterm
      // selection the initial mousedown started, and arm the click swallow so xterm's link never fires.
      p.active = true;
      // setPointerCapture throws (InvalidStateError) if the pointer isn't active — guard so a synthetic
      // event sequence (tests) never breaks the gesture.
      try {
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* no active pointer to capture — the shield still isolates xterm */
      }
      (runtimesRef.current.get(p.paneId)?.handle?.terminal as unknown as { clearSelection?: () => void } | undefined)?.clearSelection?.();
      suppressClickRef.current = true;
      setPaneDragging(true);
    }
    e.preventDefault();
    e.stopPropagation();
    pendingPointerRef.current = { x: e.clientX, y: e.clientY };
    schedulePaneHoverFlush();
  };

  const onPanePointerUpCapture = (e: ReactPointerEvent) => {
    const p = pickupRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    if (!p.active) {
      pickupRef.current = null; // a sub-slop ⌘-click — let it through (the link opens)
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* not captured — nothing to release */
    }
    // Synchronously compute the FINAL zone from the release coords — a quick release before the rAF frame
    // fired must not commit a stale/null preview (the divider-drag guarantee).
    endPaneDrag(true, computeDropTarget(e.clientX, e.clientY));
  };

  const onPanePointerCancel = () => {
    if (pickupRef.current?.active) endPaneDrag(false);
    else pickupRef.current = null;
  };

  // Swallow the one synthetic click after a real pickup so xterm's OSC 8 link `activate` never fires.
  const onPaneClickCapture = (e: ReactMouseEvent) => {
    if (suppressClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressClickRef.current = false;
    }
  };

  // Esc cancels an in-flight pane drag (tree + focus unchanged). Only while dragging.
  useEffect(() => {
    if (!paneDragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        endPaneDrag(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [paneDragging]);

  // Cancel a pending pane-drag frame on unmount (no dispatch into a dead reducer).
  useEffect(() => {
    return () => {
      if (paneDragFrameRef.current) paneDragFrameRef.current();
    };
  }, []);

  // trmx-190: the AI sessions the counter renders — the e2e fixture (dev-server only) or the live
  // derive over tab state. Cheap per render (a few tabs × panes); the pure module owns the rules.
  const aiSessions = titleBarCounterFixture ?? sessionsFrom(state.tabs);

  // trmx-81: the position class + the strip's axis. The JSX order NEVER changes (hosts first, strip
  // LAST): barLayoutFor's flex direction moves the bar; the keyed pane hosts stay put (keep-alive).
  const barLayout = barLayoutFor(barPosition);
  const labelOrientation = labelOrientationFor(barPosition, sideLabelOrientation);
  // trmx-90: `badgeColor` is now live state (updated on every appearance.theme event, incl. a same-id
  // hot-reload), not a per-render derive — see the useState above.

  return (
    <main className={`app app--bar-${barPosition}`}>
      {/* trmx-188: the app-drawn title bar — FIRST child, OUTSIDE the direction-flipping app-body,
          so it tops the window for every barPosition. It consumes the same active-tab derived
          title the native-title effect pushes (the component never re-derives). The right slot is
          trmx-190's mount point; the ?e2e.titleBarSlot= fixture (the trmx-81 D1 query-seam
          precedent — the packaged app never navigates with a query) lets e2e prove the slot wins
          against real content. */}
      <TitleBar
        title={activeTitle ?? ""}
        rightSlot={
          <>
            {titleBarSlotFixture !== null ? <span>{titleBarSlotFixture}</span> : null}
            {/* trmx-238 (M19): config-file warnings were visible ONLY in the settings window, so a
                hand-edited typo in termixion.toml said nothing here. Placed before the AI counter:
                a degraded config is more urgent than a session count, and the badge is narrow. */}
            <ConfigWarningsBadge
              onOpenSettings={() => {
                invoke("open_settings_window", { section: null }).catch((err: unknown) =>
                  log.error("open settings (config warnings) failed", err),
                );
              }}
            />
            {/* trmx-190: the AI-session counter — gated by titleBar.aiCounter, absent with no AI
                sessions. The fixture (dev-server e2e only) substitutes synthetic sessions. */}
            {aiCounterOn && aiSessions.length > 0 && (
              <AiSessionCounter
                sessions={aiSessions}
                onFocusSession={({ tabId, paneId }) => {
                  dispatch({ kind: "activateTab", tabId });
                  dispatch({ kind: "focusPane", tabId, paneId });
                }}
              />
            )}
          </>
        }
      />
      <div className="app-body">
      <div className="tab-hosts" ref={contentRef}>
        {state.tabs.map((tab) => {
          // KEEP-ALIVE: every tab's host stays mounted (keyed by the never-reused tabId); switching
          // only toggles visibility. trmx-84: within it, each pane is an absolutely-positioned
          // sibling keyed by paneId, laid out from solveRects — a re-layout mutates only style.
          const solved = solveRects(tab.tree, bounds);
          // trmx-87 (FR-3.6) + trmx-175: each divider is drawn active ONLY over the segment where it
          // borders the focused pane (its perpendicular overlap), not along its whole length. A pure
          // style flip — no re-layout, no terminal touch.
          const activeSegments = activeDividerSegments(solved.panes, solved.dividers, tab.focusedPaneId);
          return (
            <div
              key={tab.tabId}
              className="tab-host"
              data-testid={`tab-host-${tab.tabId}`}
              style={{ display: tab.tabId === state.activeTabId ? undefined : "none" }}
            >
              {solved.panes.map(({ paneId, rect }) => {
                const pane = tab.panes[paneId];
                // trmx-90: the badge's narrow-pane threshold reads cols off the mounted terminal (a
                // localized cast, like the scrollbar's ScrollbarTerminalLike) with a sane fallback
                // before the first fit / under a headless stub. Reactive enough: a resize/split/badge
                // change re-renders App and re-reads it, and a badge only ever lands on a live
                // terminal. trmx-149: font SIZING no longer needs cell metrics — the iTerm2 fit-to-box
                // model runs on the pane rect itself (BadgeOverlay gets rect.width/height below).
                const metrics = runtimesRef.current.get(paneId)?.handle?.terminal as unknown as
                  | { cols?: number }
                  | undefined;
                const cellsWide = metrics?.cols ?? FALLBACK_BADGE_COLS;
                return (
                  <div
                    key={paneId}
                    className={
                      `pane-host${paneId === tab.focusedPaneId ? " pane-host--focused" : ""}` +
                      (paneDragging && pickupRef.current?.paneId === paneId ? " pane-host--lifted" : "")
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
                    // trmx-225: focus-follows-mouse (opt-in). Bubble phase, passive (no
                    // preventDefault), cheap early-outs via the pure decision; the last-position
                    // ref updates unconditionally so the real-movement guard sees every event.
                    onMouseMove={(e) => {
                      const last = lastPointerRef.current;
                      const moved =
                        last === null || last.x !== e.clientX || last.y !== e.clientY;
                      // Allocate only on actual movement (the stationary case leaves the
                      // last position untouched by definition) — the event-cadence budget.
                      if (moved) lastPointerRef.current = { x: e.clientX, y: e.clientY };
                      if (
                        !shouldFocusOnHover(
                          ffmRef.current,
                          moved,
                          tab.focusedPaneId === paneId,
                          renamingRef.current !== null ||
                            badgingRef.current !== null ||
                            openSearchRef.current.size > 0 ||
                            pendingCloseRef.current !== null ||
                            scriptPickerRef.current !== null ||
                            paneDragging ||
                            pickupRef.current !== null ||
                            dragRef.current !== null,
                        )
                      ) {
                        return;
                      }
                      dispatch({ kind: "focusPane", tabId: tab.tabId, paneId });
                      // Mirror the click path: the hovered pane's terminal takes the keyboard
                      // (the suspension set above already covers every onReady-guard condition).
                      const handle = runtimesRef.current.get(paneId)?.handle;
                      (
                        handle?.terminal as unknown as { focus?: () => void } | undefined
                      )?.focus?.();
                    }}
                    // trmx-100: ⌘-drag to re-dock (capture phase — intercept before xterm selects/links).
                    onPointerDownCapture={onPanePointerDownCapture(tab.tabId, paneId)}
                    onPointerMoveCapture={onPanePointerMoveCapture}
                    onPointerUpCapture={onPanePointerUpCapture}
                    onPointerCancel={onPanePointerCancel}
                    onLostPointerCapture={onPanePointerCancel}
                    onClickCapture={onPaneClickCapture}
                  >
                    <TerminalView
                      onReady={readyFor(tab.tabId, paneId)}
                      cwdStore={storeFor(paneId)}
                      onOscTitle={oscTitleFor(tab.tabId, paneId)}
                      onBadge={badgeFor(tab.tabId, paneId)}
                      onPromptMarker={promptMarkerFor(tab.tabId, paneId)}
                    />
                    {/* trmx-91/160: the top-edge activity line (click-through, below the badge). Shown while
                        this pane is busy (its lightActive-derived activityVisible) OR flashing a failed
                        command's exit code (trmx-99), AND the setting is on. A busy pane renders the
                        iTerm2 progress-bar clone keyed on the theme mode; a flash renders the trmx-99
                        error-color look (flashing overrides, and a new command clears the flash first). */}
                    <ActivityLineOverlay
                      visible={
                        activityIndicatorOn && (pane.activityVisible === true || flashingPanes.has(paneId))
                      }
                      color={activityErrorColor}
                      isDark={activityIsDark}
                      flashing={flashingPanes.has(paneId)}
                    />
                    {/* trmx-90: the translucent badge watermark (top-right, click-through). Hidden by
                        BadgeOverlay itself when the pane has no badge or is too narrow. trmx-149: it
                        fits iTerm2's box (0.5 × width, 0.2 × height) over THIS pane's rect, with the
                        glyph stroke in the theme background. */}
                    <BadgeOverlay
                      badge={pane.badge}
                      cellsWide={cellsWide}
                      paneWidthPx={rect.width}
                      paneHeightPx={rect.height}
                      color={badgeColor}
                      outlineColor={badgeOutlineColor}
                    />
                    {/* trmx-90: the ⇧⌘B inline editor, over this pane while it is being badged. */}
                    {paneId === badgingPaneId && (
                      <PaneBadgeInput
                        key={`badge-input-${paneId}`}
                        initial={pane.badge ?? ""}
                        onCommit={(value) => commitBadge(paneId, value)}
                        onCancel={cancelBadge}
                      />
                    )}
                    {/* trmx-98 (FR-1.5): the per-pane find bar. Rendered only when open AND the pane's
                        terminal handle (with its search addon) is ready. */}
                    {openSearchPanes.has(paneId) &&
                      runtimesRef.current.get(paneId)?.handle?.search &&
                      (() => {
                        const search = runtimesRef.current.get(paneId)!.handle!.search;
                        return (
                          <FindBar
                            key={`find-bar-${paneId}`}
                            search={search}
                            colors={searchColors}
                            onClose={() => {
                              search.clearDecorations();
                              setOpenSearchPanes((prev) => {
                                const next = new Set(prev);
                                next.delete(paneId);
                                return next;
                              });
                              (
                                runtimesRef.current.get(paneId)?.handle?.terminal as unknown as
                                  | { focus?: () => void }
                                  | undefined
                              )?.focus?.();
                            }}
                            onRegister={(c) => {
                              if (c) setPaneField(paneId, "search", c);
                              else setPaneField(paneId, "search", undefined);
                            }}
                          />
                        );
                      })()}
                  </div>
                );
              })}
              {solved.dividers.map((d) => {
                // trmx-85: 1px visual line + a widened (~7px) hit area (index.css) that drag-resizes the
                // split. Pointer handlers stopPropagation so a grab never focuses a pane; double-click
                // resets to 50/50. Chrome/styling is FR-3.6.
                // trmx-175: the base line stays INACTIVE; when this divider borders the focused pane, an
                // active-colored overlay (pointer-events: none) covers only that segment — a full-height
                // divider next to a bottom pane is blue only over the bottom half, not the whole line.
                const key = d.path.join("-") || "root";
                const seg = activeSegments.get(dividerKey(d.path));
                return (
                  <div
                    key={`divider-${key}`}
                    className={`pane-divider pane-divider--${d.dir} pane-divider--inactive`}
                    data-testid={`pane-divider-${key}`}
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
                  >
                    {seg && (
                      <div
                        className="pane-divider__active"
                        data-testid={`pane-divider-active-${key}`}
                        style={
                          d.dir === "row"
                            ? { left: 0, width: "100%", top: seg.offset, height: seg.length }
                            : { top: 0, height: "100%", left: seg.offset, width: seg.length }
                        }
                      />
                    )}
                  </div>
                );
              })}
              {/* trmx-100: the drop-zone preview — the highlighted half (edge) or whole pane (center-swap)
                  of the hovered target, in the accent color at low alpha. Active tab + live drag only. */}
              {tab.tabId === state.activeTabId &&
                dropPreview &&
                (() => {
                  const target = solved.panes.find((p) => p.paneId === dropPreview.paneId);
                  if (!target) return null;
                  const r = target.rect;
                  const z = dropPreview.zone;
                  const pr =
                    z === "center"
                      ? r
                      : z === "left"
                        ? { ...r, width: r.width / 2 }
                        : z === "right"
                          ? { ...r, x: r.x + r.width / 2, width: r.width / 2 }
                          : z === "top"
                            ? { ...r, height: r.height / 2 }
                            : { ...r, y: r.y + r.height / 2, height: r.height / 2 };
                  return (
                    <div
                      className="pane-drop-preview"
                      data-testid="pane-drop-preview"
                      data-zone={z}
                      style={{ position: "absolute", left: pr.x, top: pr.y, width: pr.width, height: pr.height }}
                    />
                  );
                })()}
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
        {/* trmx-100: while ⌘-dragging a pane, a transparent shield owns the pointer so xterm (and any
            mouse-mode app like htop) sees no stray events. Cleared on every endPaneDrag path. */}
        {paneDragging && <div className="pane-redock-overlay" data-testid="pane-redock-overlay" />}
      </div>
      <TabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        renamingTabId={renamingTabId}
        activityIndicatorOn={activityIndicatorOn}
        // trmx-151: the ⌘N hints — the live EFFECTIVE keymap (rebuilt on keys:changed) plus the
        // tabs.showShortcutHints render gate; the strip does the positional reverse lookup.
        keymap={keymap}
        shortcutHintsOn={shortcutHintsOn}
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
      {scriptPickerRequest !== null && (
        <ScriptPicker
          invoke={invoke}
          onRun={(entry) => {
            const surface = scriptPickerRequest;
            setScriptPickerRequest(null);
            runScriptInSurface(entry, surface);
          }}
          onCancel={() => setScriptPickerRequest(null)}
        />
      )}
      {showPalette && (
        <CommandPalette
          commands={commandsRef.current}
          dispatch={(id, arg) => {
            dispatcherRef.current?.dispatch(id, arg);
          }}
          recentCommandIds={dispatcherRef.current?.recentCommandIds() ?? []}
          ctx={commandCtxRef.current}
          keymap={keymap}
          themes={listThemes().map((entry) => ({ id: entry.id, title: entry.label }))}
          invoke={invoke}
          onClose={() => setShowPalette(false)}
        />
      )}
      {/* trmx-144: the confirm-before-close dialog (pane / tab / quit) — mounted by the close
          gates instead of closing; confirm re-enters the close with { confirmed: true }. */}
      {pendingClose !== null && (
        <ConfirmCloseDialog
          kind={pendingClose.kind}
          names={pendingClose.names}
          busyTabCount={pendingClose.busyTabCount}
          onConfirm={confirmPendingClose}
          onCancel={cancelPendingClose}
        />
      )}
      </div>
    </main>
  );
}

/**
 * trmx-188: the e2e right-slot fixture, read ONCE at module load (the slot's real content is the
 * trmx-190 counter). Guarded like every browser-global read in a module that jsdom also imports.
 */
const titleBarSlotFixture: string | null =
  typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("e2e.titleBarSlot");

/**
 * trmx-190: the counter's e2e fixture — `?e2e.aiCounter=claude:2/3,codex:0/2,Other:1/1` becomes
 * synthetic sessions (one per counted total, `active` for the first `active` of each bucket,
 * titles `fixture-<bucket>-<i>`), letting the runtime-less Playwright tier drive the CSS contract.
 * Junk-tolerant: any malformed part (or an unknown bucket, or active > total) → no fixture.
 */
export function parseAiCounterFixture(raw: string | null): AiSession[] | null {
  if (raw === null) return null;
  const buckets = new Set<string>([...NAMED_BUCKETS, "Other"]);
  const sessions: AiSession[] = [];
  let paneId = 1;
  for (const part of raw.split(",")) {
    const match = /^([A-Za-z-]+):(\d+)\/(\d+)$/.exec(part.trim());
    if (!match || !buckets.has(match[1])) return null;
    const active = Number(match[2]);
    const total = Number(match[3]);
    if (active > total) return null;
    for (let i = 1; i <= total; i += 1) {
      sessions.push({
        tabId: 1,
        paneId: paneId++,
        bucket: match[1] as AiSession["bucket"],
        name: match[1] === "Other" ? "gemini" : match[1],
        title: `fixture-${match[1]}-${i}`,
        active: i <= active,
      });
    }
  }
  return sessions;
}

const titleBarCounterFixture: AiSession[] | null =
  typeof window === "undefined"
    ? null
    : parseAiCounterFixture(new URLSearchParams(window.location.search).get("e2e.aiCounter"));

/**
 * trmx-90: the ⇧⌘B inline BADGE EDITOR — a small centered input over the focused pane. Mirrors
 * TabStrip's TabRenameInput discipline: local `value` seeded ONCE from the pane's current badge (a
 * re-render mid-edit must not clobber the user's typing — useState ignores later `initial` values),
 * autofocus + select-all on mount (so it is keyboard-operable the instant ⇧⌘B opens it), and a
 * `done` latch so commit/cancel fires exactly once (Enter commits and the input unmounts; the
 * resulting blur must not then cancel). Enter commits; Esc AND blur cancel (no dispatch). Every
 * keydown stopPropagation's so Enter/Esc are TRAPPED here — they never reach xterm or the window-
 * capture tab keymap (the ⇧⌘B chord itself is swallowed by the menu accelerator upstream).
 */
function PaneBadgeInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      data-testid="pane-badge-input"
      className="tx-badge-input"
      aria-label="Set pane badge"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        // Trap Enter/Esc so they commit/cancel HERE and never leak to xterm or the tab keymap.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={cancel}
      // Isolate pointer gestures from the pane's click-to-focus / xterm selection.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
