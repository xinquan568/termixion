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
} from "react";
import { type SettingsObservation } from "./terminal/TerminalView";
import { NAMED_BUCKETS, sessionsFrom, type AiSession } from "./chrome/aiSessionBuckets";
import { barLayoutFor, labelOrientationFor } from "./tabs/barLayout";
import {
  initialTabsState,
  paneBySessionId,
  reduceTabs,
} from "./tabs/tabState";
import {
  type DividerRect,
  type PaneId,
  type Rect,
  type SplitDir,
} from "./panes/layoutTree";
import { type DropZone } from "./panes/dropZone";
import { collectBusyTabs, shouldConfirmClose } from "./panes/closeGuard";
import { type FrameSchedule } from "./terminal/resizeCoalescer";
import {
  makeSettingsStore,
  type LabelOrientation,
  type TabBarPosition,
} from "./store/settingsStore";
import { resolveTheme } from "./theme/registry";
import { useBackend } from "./ipc/useBackend";
import {
  closePty,
  onPtyExited,
  onSessionActivity,
  onTitleHint,
  realInvoke,
  sendPtyInput,
  type InvokeFn,
} from "./ipc/backend";
import { realObserveServiceNudge, type ServiceNudgeObservation } from "./ipc/serviceNudge";
import { makeIdReservation, type IdReservation } from "./tabs/idReservation";
import { buildCommands, type Command, type CommandContext } from "./commands/registry";
import { createDispatcher, type Dispatcher } from "./commands/dispatch";
import { FULL_DEFAULT_KEYS, mergeKeymap } from "./commands/keymapDispatch";
import { installThemeHotReload } from "./startup/themeHotReload";
import { makeCwdStore } from "./terminal/osc7";
import { createPaneRuntimes, type PaneRuntime } from "./app/paneRuntime";
import { usePaneCallbacks } from "./app/usePaneCallbacks";
import { usePaneActivity } from "./app/usePaneActivity";
import { useCloseGuard } from "./app/useCloseGuard";
import { useCommandContext } from "./app/useCommandContext";
import { usePaneOps } from "./app/usePaneOps";
import { usePaneDrag } from "./app/usePaneDrag";
import { AppView } from "./app/AppView";
import { useAppServices } from "./app/useAppServices";
import { realSetWindowTitle } from "./terminal/windowTitle";


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
import { DEFAULT_BOUNDS, type ActivityObservation } from "./panes/appConstants";
import type { PendingClose } from "./app/closeContracts";
import {
  realFrameSchedule,
  realObserveAppSettings,
  type AttachFn,
} from "./terminal/appSeams";
import { realObserveControlRequest, type ControlRequestObservation } from "./control/controlRequestSeam";

// trmx-254: the `ControlRequest` facade stays exported from App.tsx so existing importers
// (App.confirmClose.test.tsx) keep working; the seam itself now lives in control/.
export type { ControlRequest } from "./control/controlRequestGuard";

export type AppDeps = {
  attach?: AttachFn;
  closeWindow?: () => void;
  quitConfirmed?: () => void;
  closeAcknowledged?: (generation: number) => Promise<void>;
  closeSession?: (sessionId: number) => Promise<void>;
  observeTabsAction?: TabsActionObservation;
  observePtyExited?: PtyExitedObservation;
  observeTitleHint?: TitleHintObservation;
  observeActivity?: ActivityObservation;
  observeOutput?: OutputObservation;
  observeInput?: InputObservation;
  observeSettings?: SettingsObservation;
  observeControlRequest?: ControlRequestObservation;
  observeSessionNotice?: SessionNoticeObservation;
  observeCloseRequested?: CloseRequestedObservation;
  setWindowTitle?: (title: string) => void;
  dragSchedule?: FrameSchedule;
  installHotReload?: typeof installThemeHotReload;
  sendInput?: (sessionId: number, data: string) => Promise<void>;
  invoke?: InvokeFn;
  serviceBootPaths?: string[];
  observeServiceNudge?: ServiceNudgeObservation;
};

/** trmx-254: the 22 seams are now one object; `deps` replaces the flat prop list. */
export interface AppProps {
  deps?: AppDeps;
}

// trmx-254 (T12): the 22 injection seams become ONE `deps` object. Defaults live at MODULE scope so
// their identity is stable across renders, and each field resolves with `??` — never a spread merge.
// That distinction is behavioural, not stylistic: `{...DEFAULTS, ...deps}` RETAINS an explicitly
// passed `undefined`, so a test that writes `invoke: opts.invoke` (with `opts.invoke` undefined)
// would silently get `undefined` instead of the production default. Several tests do exactly that.
const DEPS_DEFAULTS = {
  closeWindow: realCloseWindow,
  quitConfirmed: realQuitConfirmed,
  closeAcknowledged: realCloseAcknowledged,
  closeSession: closePty,
  observeTabsAction: realObserveTabsAction,
  observePtyExited: onPtyExited,
  observeTitleHint: onTitleHint,
  observeActivity: onSessionActivity,
  observeSettings: realObserveAppSettings,
  observeControlRequest: realObserveControlRequest,
  observeSessionNotice: realObserveSessionNotice,
  observeCloseRequested: realObserveCloseRequested,
  observeServiceNudge: realObserveServiceNudge,
  setWindowTitle: realSetWindowTitle,
  dragSchedule: realFrameSchedule,
  installHotReload: installThemeHotReload,
  invoke: realInvoke,
  sendInput: (sessionId: number, data: string) => sendPtyInput(sessionId, data),
} as const;

export function App({ deps }: AppProps = {}) {
  // 18 defaulted seams — `??` per field, so an explicit `undefined` still resolves to the default.
  const closeWindow = deps?.closeWindow ?? DEPS_DEFAULTS.closeWindow;
  const quitConfirmed = deps?.quitConfirmed ?? DEPS_DEFAULTS.quitConfirmed;
  const closeAcknowledged = deps?.closeAcknowledged ?? DEPS_DEFAULTS.closeAcknowledged;
  const closeSession = deps?.closeSession ?? DEPS_DEFAULTS.closeSession;
  const observeTabsAction = deps?.observeTabsAction ?? DEPS_DEFAULTS.observeTabsAction;
  const observePtyExited = deps?.observePtyExited ?? DEPS_DEFAULTS.observePtyExited;
  const observeTitleHint = deps?.observeTitleHint ?? DEPS_DEFAULTS.observeTitleHint;
  const observeActivity = deps?.observeActivity ?? DEPS_DEFAULTS.observeActivity;
  const observeSettings = deps?.observeSettings ?? DEPS_DEFAULTS.observeSettings;
  const observeControlRequest = deps?.observeControlRequest ?? DEPS_DEFAULTS.observeControlRequest;
  const observeSessionNotice = deps?.observeSessionNotice ?? DEPS_DEFAULTS.observeSessionNotice;
  const observeCloseRequested = deps?.observeCloseRequested ?? DEPS_DEFAULTS.observeCloseRequested;
  const observeServiceNudge = deps?.observeServiceNudge ?? DEPS_DEFAULTS.observeServiceNudge;
  const setWindowTitle = deps?.setWindowTitle ?? DEPS_DEFAULTS.setWindowTitle;
  const dragSchedule = deps?.dragSchedule ?? DEPS_DEFAULTS.dragSchedule;
  const installHotReload = deps?.installHotReload ?? DEPS_DEFAULTS.installHotReload;
  const invoke = deps?.invoke ?? DEPS_DEFAULTS.invoke;
  const sendInput = deps?.sendInput ?? DEPS_DEFAULTS.sendInput;
  // 3 seams with NO production default — `undefined` is meaningful and must stay undefined.
  const attach = deps?.attach;
  const observeOutput = deps?.observeOutput;
  const observeInput = deps?.observeInput;
  // 1 array default.
  const serviceBootPaths = deps?.serviceBootPaths ?? [];
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
    return commands.rebuildKeymap();
  }, [invoke]);

  // Boot: exactly ONE initial tab (one pane). The ref guards StrictMode's double effect-invocation.
  // trmx-93 (FR-5): if a startup script is configured, attach it to the first pane BEFORE dispatching
  // openTab — its promise is stored in pendingScriptRef keyed by the upcoming nextPaneId, and the
  // attach send-step awaits it, so the async listScripts resolution never loses the race (finding 3).
  // Smoke/perf are already excluded: main.tsx boot() returns before App renders on those launches.
  useEffect(() => {
    return services.boot();
  }, [invoke]);

  // trmx-84: measure the pane content area for solveRects. Guarded for jsdom (no ResizeObserver) and
  // 0×0 readings, so tests keep the usable default bounds and real runtime tracks the window size.
  useEffect(() => {
    return services.observeContentSize();
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
  // trmx-254 (T4): the close concern. E11 and E05's pty-exited subscription keep their registrations
  // and dependency arrays at the root; only their bodies live in the hook. Close-time cleanup is
  // composed here: `clearForPane` (flash) comes from the activity concern, search/rename/badge
  // setters are passed in — no hook reaches into another hook's state.
  const close = useCloseGuard({
    runtimesRef, stateRef, seamsRef, pendingCloseRef, quitAuthorizedRef, dispatch,
    setPendingClose, setFlashingPanes, setOpenSearchPanes, setRenamingTabId, setBadgingPaneId,
    observeCloseRequested, observePtyExited,
  });
  const {
    setPendingCloseSynced,
    closeTabInternal, closePaneInternal, confirmPendingClose, cancelPendingClose, busyLookup,
  } = close;
  // trmx-254 (T6): the pane/tab operations. `createTab` stays internal to the hook — a symbol walk
  // shows it never escapes; `runScriptInSurface` is returned because the JSX reads it.
  const paneOps = usePaneOps({
    stateRef, runtimesRef, boundsRef, createTabRef, deliverServicePathsRef,
    dispatch, setRenamingTabId, setBadgingPaneId, seedPaneField, reservation,
    close: { closePaneInternal, closeTabInternal },
  });
  const {
    getActiveTab, requestNewTab, requestSplit, requestPaneNav,
    requestCloseActive, requestCloseTab, runScriptInSurface,
    startRename, commitRename, cancelRename, commitBadge, cancelBadge,
  } = paneOps;
  // trmx-254 (T5): commandCtxRef / keymapRef / dispatcherRef / commandsRef stay ROOT-owned. The
  // dispatcher is a SINGLETON closing over a Proxy that reads `commandCtxRef.current`, which the root
  // reassigns during render — that indirection is what lets E05/E10/E14 read it out-of-render and
  // still see current state. These refs are declared BEFORE the hook call because the hook receives
  // them; `commandCtxRef` and the dispatcher body come after, since they need `commandCtx` itself.
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;
  const dispatcherRef = useRef<Dispatcher | null>(null);
  const commands = useCommandContext({
    runtimesRef, stateRef, seamsRef, boundsRef, pendingCloseRef, keymapRef, dispatcherRef,
    dispatch, getActiveTab, invoke, flashingPanes, setKeymap, setRenamingTabId, setBadgingPaneId,
    setOpenSearchPanes, setScriptPickerRequest, setShowPalette,
    close: { closeTabInternal },
    activity: { applyActivityTransition, clearFlashFor },
    paneOps: { requestNewTab, requestSplit, requestPaneNav, requestCloseActive },
  });
  const { commandCtx } = commands;
  const commandCtxRef = useRef(commandCtx);
  commandCtxRef.current = commandCtx;
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
    return services.drainServicePaths();
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
    return services.onSessionNotice();
  }, [observeSessionNotice]);

  useEffect(() => {
    return services.installControlBridge();
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

  // trmx-81/82: keep the bar position + side-label orientation live over settings:changed. Its OWN
  // effect, dep'd only on the stable observation seam — payloads are untrusted (only a well-formed
  // key with a registry-valid value updates state).
  useEffect(() => {
    return services.onSettingsChanged();
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
    return services.installThemeHotReload();
  }, [installHotReload]);

  // ⌘1..⌘9 select a tab; ⌘D / ⇧⌘D split (trmx-84); ⌥⌘-arrows / ⌘]/⌘[ navigate panes (trmx-86). Capture
  // phase on window so the chord wins even while xterm's helper textarea has focus; tabKeymap vetoes
  // non-terminal editables and foreign chords, so nothing else is intercepted.
  useEffect(() => {
    return commands.installKeyDown();
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
    services.mirrorWindowTitle();
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

  // trmx-254 (T7): the divider drag + Cmd-drag re-dock. Every drag ref and every piece of drag state
  // stays declared above; only the logic moves. E17 stays inline (frameCancelRef + clearAllTimers).
  // trmx-254 (T11): the app-level services. Its outward set is empty — nothing declared there is read
  // anywhere else, which is what makes it a service module rather than another shared surface.
  const services = useAppServices({
    invoke, stateRef, runtimesRef, bootedRef, startupFiredRef, deliverServicePathsRef, createTabRef,
    contentRef, ffmRef, seamsRef, dispatcherRef, commandsRef, serviceBootPaths,
    activeTitle, getActiveTab, seedPaneField,
    observeServiceNudge, observeSessionNotice, observeControlRequest, observeSettings,
    installHotReload, setBounds, setBarPosition, setSideLabelOrientation, setActivityIndicatorOn,
    setShortcutHintsOn, setAiCounterOn, setBadgeColor, setBadgeOutlineColor, setActivityIsDark,
    setActivityErrorColor, setSearchColors,
  });
  const drag = usePaneDrag({
    stateRef, runtimesRef, boundsRef, contentRef, dispatch,
    dragScheduleRef, dragRef, pendingRatioRef, frameCancelRef,
    pickupRef, paneDragFrameRef, pendingPointerRef, suppressClickRef,
    setDragDir, setPaneDragging, setDropPreview,
  });
  const {
    onDividerPointerDown, onDividerPointerMove, onDividerPointerUp, onDividerPointerCancel,
    onDividerDoubleClick, onPanePointerDownCapture, onPanePointerMoveCapture,
    onPanePointerUpCapture, onPanePointerCancel, onPaneClickCapture,
  } = drag;
  useEffect(() => {
    return drag.onDragKey(paneDragging);
  }, [paneDragging]);

  // Cancel a pending pane-drag frame on unmount (no dispatch into a dead reducer).
  useEffect(() => {
    return drag.cancelPendingFrame;
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
    <AppView
      activeTitle={activeTitle}
      activityErrorColor={activityErrorColor}
      activityIndicatorOn={activityIndicatorOn}
      activityIsDark={activityIsDark}
      aiCounterOn={aiCounterOn}
      aiSessions={aiSessions}
      badgeColor={badgeColor}
      badgeFor={badgeFor}
      badgeOutlineColor={badgeOutlineColor}
      badgingPaneId={badgingPaneId}
      badgingRef={badgingRef}
      barLayout={barLayout}
      barPosition={barPosition}
      bounds={bounds}
      cancelBadge={cancelBadge}
      cancelPendingClose={cancelPendingClose}
      cancelRename={cancelRename}
      commandCtxRef={commandCtxRef}
      commandsRef={commandsRef}
      commitBadge={commitBadge}
      commitRename={commitRename}
      confirmPendingClose={confirmPendingClose}
      contentRef={contentRef}
      dispatch={dispatch}
      dispatcherRef={dispatcherRef}
      dragDir={dragDir}
      dragRef={dragRef}
      dropPreview={dropPreview}
      ffmRef={ffmRef}
      flashingPanes={flashingPanes}
      invoke={invoke}
      keymap={keymap}
      labelOrientation={labelOrientation}
      lastPointerRef={lastPointerRef}
      onDividerDoubleClick={onDividerDoubleClick}
      onDividerPointerCancel={onDividerPointerCancel}
      onDividerPointerDown={onDividerPointerDown}
      onDividerPointerMove={onDividerPointerMove}
      onDividerPointerUp={onDividerPointerUp}
      onPaneClickCapture={onPaneClickCapture}
      onPanePointerCancel={onPanePointerCancel}
      onPanePointerDownCapture={onPanePointerDownCapture}
      onPanePointerMoveCapture={onPanePointerMoveCapture}
      onPanePointerUpCapture={onPanePointerUpCapture}
      openSearchPanes={openSearchPanes}
      openSearchRef={openSearchRef}
      oscTitleFor={oscTitleFor}
      paneDragging={paneDragging}
      pendingClose={pendingClose}
      pendingCloseRef={pendingCloseRef}
      pickupRef={pickupRef}
      promptMarkerFor={promptMarkerFor}
      readyFor={readyFor}
      renamingRef={renamingRef}
      renamingTabId={renamingTabId}
      requestCloseTab={requestCloseTab}
      requestNewTab={requestNewTab}
      runScriptInSurface={runScriptInSurface}
      runtimesRef={runtimesRef}
      scriptPickerRef={scriptPickerRef}
      scriptPickerRequest={scriptPickerRequest}
      searchColors={searchColors}
      setOpenSearchPanes={setOpenSearchPanes}
      setPaneField={setPaneField}
      setScriptPickerRequest={setScriptPickerRequest}
      setShowPalette={setShowPalette}
      shortcutHintsOn={shortcutHintsOn}
      showPalette={showPalette}
      startRename={startRename}
      state={state}
      storeFor={storeFor}
    />
  );
}


/**
 * trmx-188: the e2e right-slot fixture, read ONCE at module load (the slot's real content is the
 * trmx-190 counter). Guarded like every browser-global read in a module that jsdom also imports.
 */
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
