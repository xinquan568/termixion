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
import { activeDividerKeys, dividerKey } from "./panes/paneChrome";
import { BadgeOverlay } from "./panes/BadgeOverlay";
import { ActivityLineOverlay } from "./panes/ActivityLineOverlay";
import {
  classDeadline,
  initialActivity,
  lightActive,
  onBusyChange,
  onClassifyMetadata,
  onDeadline,
  onInput as onActivityInput,
  onOutput as onActivityOutput,
  type ActivityMeta,
  type ActivityState,
  type ActivityTransition,
} from "./panes/activityLine";
import { shouldFlash, FLASH_MS } from "./panes/activityFlash";
import {
  collectBusyPanes,
  collectBusyTabs,
  paneIsBusy,
  shouldConfirmClose,
  type BusyLookup,
} from "./panes/closeGuard";
import { ConfirmCloseDialog } from "./panes/ConfirmCloseDialog";
import { type PromptTransition } from "./terminal/osc133";
import { type FrameSchedule } from "./terminal/resizeCoalescer";
import {
  isLabelOrientation,
  isTabBarPosition,
  makeSettingsStore,
  SETTINGS_CHANGED_EVENT,
  type LabelOrientation,
  type TabBarPosition,
} from "./settings/settingsStore";
import { describeTarget } from "./tabs/tabKeymap";
import { isRegisteredThemeId, isUserThemeIdShape, resolveTheme } from "./theme/registry";
import { FindBar, type SearchController } from "./search/FindBar";
import { withAlpha } from "./theme/colorMath";
import { useBackend } from "./ipc/useBackend";
import {
  closePty,
  onPtyExited,
  onSessionActivity,
  onTitleHint,
  realInvoke,
  sendPtyInput,
  setSessionTitle,
  type InvokeFn,
  type SessionInfo,
} from "./ipc/backend";
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
import { installThemeHotReload } from "./theme/themeHotReload";
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

// trmx-90: cols fallback for the badge's narrow-pane threshold before the terminal has fit (or
// under a headless test stub with no metrics) — a sane wide default so a freshly-set badge still shows
// (a badge is only ever set once a live terminal exists, so this window is effectively pre-mount only).
// trmx-149 dropped the rows twin: font sizing now fits the pane RECT (iTerm2's box), not cell metrics.
const FALLBACK_BADGE_COLS = 80;

// trmx-91: the activity line's alpha over the theme's semantic-success tint — faint enough to sit
// quietly at a pane's top edge, strong enough to read as "busy". Applied to `color.semantic.success`
// (a solid theme color) so, unlike the badge tint (already a low-alpha token), App derives the rgba.
const ACTIVITY_LINE_ALPHA = 0.8;

/** The activity line's color for a theme id: its `color.semantic.success` at {@link ACTIVITY_LINE_ALPHA}. */
function activityColorFor(themeId: string): string {
  return withAlpha(resolveTheme(themeId).color.semantic.success, ACTIVITY_LINE_ALPHA);
}

/** trmx-99: the exit-code flash color — `color.semantic.error` at the same alpha as the activity line. */
function activityErrorColorFor(themeId: string): string {
  return withAlpha(resolveTheme(themeId).color.semantic.error, ACTIVITY_LINE_ALPHA);
}

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
 * Observe `session:activity` busy<->idle transitions (trmx-91); returns a teardown. trmx-159: a busy
 * rise also carries optional classification metadata (foreground name / argv tail / stdin-tty).
 */
export type ActivityObservation = (
  onActivity: (sessionId: number, busy: boolean, meta?: ActivityMeta) => void,
) => () => void;

/** trmx-159: injection seam for tests — observe a session's PTY output byte length. */
export type OutputObservation = (
  onOutput: (sessionId: number, byteLength: number) => void,
) => () => void;

/** trmx-159: injection seam for tests — observe a session's keystroke input. */
export type InputObservation = (
  onInput: (sessionId: number, data: string) => void,
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

/**
 * trmx-144: the production quit-confirm sink — tell the backend the webview approved the quit
 * (the `close:requested` round-trip's "yes", and the remote window.close fast-path). Error-swallowed
 * like realCloseWindow: without a Tauri runtime there is nothing to quit.
 */
export function realQuitConfirmed(): void {
  realInvoke("quit_confirmed").catch(() => {
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

// trmx-101 (FR-9.4): observe the Rust control socket's requests over `control:request` — same
// teardown-before-resolve pattern. Each payload is `{ id, request }`; App routes it through the command
// dispatcher / builds the snapshot / sends text, then replies via `invoke("control_response")`.
export type ControlRequest = { id: number; request: { cmd?: unknown; args?: unknown } };
export type ControlRequestObservation = (onRequest: (req: ControlRequest) => void) => () => void;
const realObserveControlRequest: ControlRequestObservation = (onRequest) => {
  let live = true;
  let unlisten: (() => void) | undefined;
  realEventBus
    .listen("control:request", (payload) => {
      if (live) onRequest(payload as ControlRequest);
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — there is no control socket in a plain browser tab.
    });
  return () => {
    live = false;
    unlisten?.();
  };
};

// trmx-144: observe the backend's `close:requested` broadcasts (the native window close / ⌘Q
// intercepted Rust-side and round-tripped to the webview for the quit confirm) — the same
// teardown-before-resolve pattern as realObserveControlRequest above.
export type CloseRequestedObservation = (onRequest: () => void) => () => void;
const realObserveCloseRequested: CloseRequestedObservation = (onRequest) => {
  let live = true;
  let unlisten: (() => void) | undefined;
  realEventBus
    .listen("close:requested", () => {
      if (live) onRequest();
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — the OS never routes a window close through the webview.
    });
  return () => {
    live = false;
    unlisten?.();
  };
};

// trmx-144: one close's options, threaded pane → tab so a close that already passed (or bypassed)
// the confirm gate is never re-gated downstream.
type CloseOpts = {
  /** The session already exited on its own (pty:exited) — nothing left to protect, no close_pty. */
  alreadyExited?: boolean;
  /** Who asked: "remote" (control channel) never prompts — a dialog would deadlock a headless caller. */
  origin?: "user" | "remote";
  /** The user just confirmed THIS close in the dialog — proceed without re-prompting. */
  confirmed?: boolean;
};

// trmx-144: the pending confirm-before-close dialog's target (null = no dialog). `tabId`/`paneId`
// pin the target by id so a confirm re-resolves it (a dead target makes confirm a safe no-op).
type PendingClose = {
  kind: "pane" | "tab" | "quit";
  tabId?: number;
  paneId?: PaneId;
  names: string[];
  /** Quit only: how many tabs have running programs — the dialog's summary line. */
  busyTabCount?: number;
};

export interface AppProps {
  /** Injection seam for tests; defaults to useBackend's attachTerminal (the live PTY wiring). */
  attach?: AttachFn;
  /** Injection seam for tests; defaults to closing the native window (last-tab close). */
  closeWindow?: () => void;
  /** Injection seam for tests; defaults to the real `quit_confirmed` invoke (trmx-144). */
  quitConfirmed?: () => void;
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
  /** Injection seam for tests; the backend's `close:requested` stream (trmx-144). */
  observeCloseRequested?: CloseRequestedObservation;
  /** Injection seam for tests; defaults to retitling the native window (trmx-75). */
  setWindowTitle?: (title: string) => void;
  /** Injection seam for tests; defaults to the real `set_session_title` core mirror (trmx-75). */
  mirrorTitle?: (sessionId: number, title: string) => Promise<void>;
  /** Injection seam for tests; the frame schedule that throttles divider-drag dispatches (trmx-85). */
  dragSchedule?: FrameSchedule;
  /** Injection seam for tests; defaults to the real themes hot-reload installer (trmx-89). */
  installHotReload?: typeof installThemeHotReload;
  /** Injection seam for tests; defaults to the real `pty_write` (trmx-93 — sends a sourced script). */
  sendInput?: (sessionId: number, data: string) => Promise<void>;
  /** Injection seam for tests; the backend `invoke` for the script picker + startup resolution (trmx-93). */
  invoke?: InvokeFn;
}

export function App({
  attach,
  closeWindow = realCloseWindow,
  quitConfirmed = realQuitConfirmed,
  closeSession = closePty,
  observeTabsAction = realObserveTabsAction,
  observePtyExited = onPtyExited,
  observeTitleHint = onTitleHint,
  observeActivity = onSessionActivity,
  observeOutput,
  observeInput,
  observeSettings = realObserveAppSettings,
  observeControlRequest = realObserveControlRequest,
  observeCloseRequested = realObserveCloseRequested,
  setWindowTitle = realSetWindowTitle,
  mirrorTitle = setSessionTitle,
  dragSchedule = realFrameSchedule,
  installHotReload = installThemeHotReload,
  sendInput = (sessionId, data) => sendPtyInput(sessionId, data),
  invoke = realInvoke,
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
  // trmx-91: the activity line's COLOR — the active theme's semantic-success tint at ~80% alpha,
  // tracked as RESOLVED state exactly like badgeColor (review-1: the trmx-89 hot-reload re-emits the
  // SAME user-theme id after re-registering tokens, so keying on the id would leave the line on a
  // stale color; the resolved color repaints). resolveTheme is total, so any id resolves.
  const [activityColor, setActivityColor] = useState<string>(() =>
    activityColorFor(makeSettingsStore().get("appearance.theme")),
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
  const storesRef = useRef(new Map<PaneId, CwdStore>()); // OSC 7 cwd, one store per pane
  const handlesRef = useRef(new Map<PaneId, TerminalHandle>()); // mounted terminals
  const sessionsRef = useRef(new Map<PaneId, number>()); // attached backend sessionIds
  const pendingCwdRef = useRef(new Map<PaneId, string | undefined>()); // cwd to seed the open with
  // trmx-93 (FR-5): a script to source once its pane's session attaches, keyed by the pane's
  // (predictable) nextPaneId and set SYNCHRONOUSLY before the creating dispatch — so the async
  // startup resolution can never lose the race with attach (the send-step awaits the promise).
  const pendingScriptRef = useRef(new Map<PaneId, Promise<{ sourceLine: string } | null>>());
  const startupFiredRef = useRef(false); // trmx-93: the startup script fires at most once
  const readyCbsRef = useRef(new Map<PaneId, (handle: TerminalHandle) => void>()); // stable onReady per pane
  const oscTitleCbsRef = useRef(new Map<PaneId, (title: string) => void>()); // stable onOscTitle per pane
  const badgeCbsRef = useRef(new Map<PaneId, (badge: string | null) => void>()); // stable onBadge per pane (trmx-90)
  const mirroredRef = useRef(new Map<PaneId, string>()); // last title mirrored to the core, per pane
  // Attach epoch per pane: each onReady bumps it; a resolution whose epoch is no longer current is
  // STALE (StrictMode's dev remount opens two PTYs — only the current epoch keeps its session).
  const attachEpochRef = useRef(new Map<PaneId, number>());
  // trmx-91: per-pane activity DEBOUNCE state + its single timer, both keyed by the global paneId. App
  // owns the debounce (panes/activityLine.ts is pure/time-injected): each pane holds an ActivityState
  // and at most ONE pending timer, armed to the current transition's deadline (cleared + re-armed on
  // every transition, disposed on pane close / unmount).
  const activityStatesRef = useRef(new Map<PaneId, ActivityState>());
  const activityTimersRef = useRef(new Map<PaneId, ReturnType<typeof setTimeout>>());
  // trmx-99 (FR-7b): panes whose activity is OSC-133-owned (the poller's session:activity is ignored for
  // them, sticky per session); their stable onPromptMarker callbacks; and the per-pane exit-flash timers.
  const osc133PanesRef = useRef(new Set<PaneId>());
  const promptMarkerCbsRef = useRef(new Map<PaneId, (t: PromptTransition) => void>());
  const activityFlashTimersRef = useRef(new Map<PaneId, ReturnType<typeof setTimeout>>());
  const renamingRef = useRef(renamingTabId); // out-of-render read for the onReady focus guard
  const badgingRef = useRef(badgingPaneId); // out-of-render read for the onReady focus guard (trmx-90)
  const openSearchRef = useRef(openSearchPanes); // out-of-render read for the onReady focus guard (trmx-98)
  const searchControllersRef = useRef(new Map<PaneId, SearchController>()); // trmx-98: per-pane find bars
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
    closeSession,
    setWindowTitle,
    mirrorTitle,
    sendInput,
  });
  seamsRef.current = {
    attach: attachFn,
    closeWindow,
    quitConfirmed,
    closeSession,
    setWindowTitle,
    mirrorTitle,
    sendInput,
  };
  boundsRef.current = bounds;
  renamingRef.current = renamingTabId;
  badgingRef.current = badgingPaneId;
  openSearchRef.current = openSearchPanes;

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
      const startupPath = makeSettingsStore().get("scripts.startup");
      if (startupPath && !startupFiredRef.current) {
        startupFiredRef.current = true;
        const upcoming = stateRef.current.nextPaneId;
        pendingScriptRef.current.set(
          upcoming,
          listScripts(invoke).then((scripts) => {
            const match = scripts.find((entry) => entry.relPath === startupPath);
            if (!match) {
              console.warn(
                `[termixion] startup script "${startupPath}" not found in ~/.config/termixion/scripts/; starting a plain shell`,
              );
              return null;
            }
            return { sourceLine: match.sourceLine };
          }),
        );
      }
      dispatch({ kind: "openTab" });
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
        if (
          activeTab &&
          activeTab.focusedPaneId === paneId &&
          renamingRef.current === null &&
          badgingRef.current === null &&
          !openSearchRef.current.has(paneId) // trmx-98: an open find bar owns the keyboard
        ) {
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
              // trmx-93 (FR-5): if a script is pending for this pane (a picker run, or the startup
              // script), source it now that the session is live. Consumed ONLY on the current epoch so
              // a superseded StrictMode attach can't steal it; awaits the stored promise (startup's
              // async resolution), then sends `source '<abs>'` + CR through the sendInput seam.
              const pendingScript = pendingScriptRef.current.get(paneId);
              if (pendingScript) {
                pendingScriptRef.current.delete(paneId);
                void pendingScript.then((resolved) => {
                  if (resolved && paneAlive(tabId, paneId)) {
                    seamsRef.current.sendInput(info.sessionId, `${resolved.sourceLine}\r`).catch(
                      (err: unknown) => {
                        console.error("[termixion] sourcing the script failed", err);
                      },
                    );
                  }
                });
              }
            } else {
              // ORPHAN GUARD: the pane/tab closed mid-attach, OR this is a superseded (StrictMode)
              // mount — kill the session it will never show.
              seamsRef.current.closeSession(info.sessionId).catch((err: unknown) => {
                console.error("[termixion] orphan session close failed", err);
              });
              // trmx-93: if the pane is truly DEAD (not merely a stale epoch on a still-live pane),
              // drop its pending script — no later attach will consume it. A stale-epoch-but-alive
              // pane keeps it so the current-epoch attach still sources it.
              if (!paneAlive(tabId, paneId)) pendingScriptRef.current.delete(paneId);
            }
          })
          .catch((err: unknown) => {
            // Open failed (no backend in `pnpm dev`, or a real spawn error): the pane keeps its
            // placeholder title with a dead session — do not crash the shell.
            console.error("[termixion] pane attach failed", err);
            pendingScriptRef.current.delete(paneId); // trmx-93: no session → the script never sources
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

  // trmx-90: this pane's onBadge, cached like readyFor/oscTitleFor (a stable identity — an inline
  // arrow would remount the terminal via TerminalView's effect deps). An OSC 1337 SetBadgeFormat
  // lands in THIS pane's `badge` slot (last-write-wins); null (empty/undecodable/cleared) removes it.
  // The per-pane closure is the load-bearing SCOPING — a `printf` in a BACKGROUND pane badges that
  // pane, never the focused one (the badge is orthogonal to the tab label by construction).
  const badgeFor = (tabId: number, paneId: PaneId): ((badge: string | null) => void) => {
    let cb = badgeCbsRef.current.get(paneId);
    if (!cb) {
      cb = (badge) => {
        dispatch({ kind: "setBadge", tabId, paneId, badge });
      };
      badgeCbsRef.current.set(paneId, cb);
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
  const applyActivityTransition = (
    tabId: number,
    paneId: PaneId,
    { state, deadline }: ActivityTransition,
  ) => {
    activityStatesRef.current.set(paneId, state);
    const prior = activityTimersRef.current.get(paneId);
    if (prior !== undefined) {
      clearTimeout(prior);
      activityTimersRef.current.delete(paneId);
    }
    const now = Date.now();
    // trmx-159: fold the class-layer deadline (unknown-fallback / light-off / window-close) with the
    // phase deadline into the single per-pane timer — arm to whichever fires first.
    const classAt = classDeadline(state, now);
    const armAt =
      deadline === null ? classAt : classAt === null ? deadline : Math.min(deadline, classAt);
    if (armAt !== null) {
      const timer = setTimeout(() => {
        activityTimersRef.current.delete(paneId);
        const current = activityStatesRef.current.get(paneId) ?? initialActivity();
        applyActivityTransition(tabId, paneId, onDeadline(current, Date.now()));
      }, Math.max(0, armAt - now));
      activityTimersRef.current.set(paneId, timer);
    }
    // trmx-159: the visible line/dot follow `lightActive` (executing-user-work), not raw visibility;
    // the close guard still reads isBusy(state) (rawBusy) via busyLookup, unchanged.
    dispatch({ kind: "setActivity", tabId, paneId, visible: lightActive(state, now) });
  };

  // trmx-159: the per-pane I/O observers — route PTY output / keystroke input into the activity
  // classifier through the same single-writer applyActivityTransition. Repointed each render so they
  // always close over the live refs; useBackend (production) and the test seams both call these.
  ioObserversRef.current = {
    output: (sessionId, byteLength) => {
      const hit = paneBySessionId(stateRef.current, sessionId);
      if (!hit) return;
      const current = activityStatesRef.current.get(hit.paneId) ?? initialActivity();
      applyActivityTransition(hit.tab.tabId, hit.paneId, onActivityOutput(current, byteLength, Date.now()));
    },
    input: (sessionId, data) => {
      const hit = paneBySessionId(stateRef.current, sessionId);
      if (!hit) return;
      const current = activityStatesRef.current.get(hit.paneId) ?? initialActivity();
      applyActivityTransition(hit.tab.tabId, hit.paneId, onActivityInput(current, data, Date.now()));
    },
  };

  // trmx-99 (FR-7b): start / cancel a pane's exit-code flash. The flashing set drives the overlay
  // re-render; the timer clears it after FLASH_MS. A new command (C) cancels a stale flash.
  const startFlash = (paneId: PaneId) => {
    const prior = activityFlashTimersRef.current.get(paneId);
    if (prior !== undefined) clearTimeout(prior);
    setFlashingPanes((prev) => new Set(prev).add(paneId));
    const timer = setTimeout(() => {
      activityFlashTimersRef.current.delete(paneId);
      setFlashingPanes((prev) => {
        if (!prev.has(paneId)) return prev;
        const next = new Set(prev);
        next.delete(paneId);
        return next;
      });
    }, FLASH_MS);
    activityFlashTimersRef.current.set(paneId, timer);
  };
  const clearFlashFor = (paneId: PaneId) => {
    const prior = activityFlashTimersRef.current.get(paneId);
    if (prior !== undefined) {
      clearTimeout(prior);
      activityFlashTimersRef.current.delete(paneId);
    }
    setFlashingPanes((prev) => {
      if (!prev.has(paneId)) return prev;
      const next = new Set(prev);
      next.delete(paneId);
      return next;
    });
  };

  // trmx-99: this pane's OSC 133 marker sink, cached like badgeFor (a stable identity — an inline arrow
  // would remount the terminal via the effect deps). ANY valid marker latches the pane to the osc133
  // source (sticky — the poller is ignored for it thereafter); App applies the activity change from the
  // machine's `busyChanged` (so an `A`-while-running clears the line), a `C` cancels a stale flash, and a
  // failed command's exit code flashes the error color.
  const promptMarkerFor = (tabId: number, paneId: PaneId): ((t: PromptTransition) => void) => {
    let cb = promptMarkerCbsRef.current.get(paneId);
    if (!cb) {
      cb = (transition) => {
        osc133PanesRef.current.add(paneId);
        if (transition.busy) clearFlashFor(paneId); // a new command wins over a leftover flash
        if (transition.busyChanged) {
          const current = activityStatesRef.current.get(paneId) ?? initialActivity();
          applyActivityTransition(tabId, paneId, onBusyChange(current, transition.busy, Date.now()));
        }
        if (shouldFlash(transition.exitCode)) startFlash(paneId);
      };
      promptMarkerCbsRef.current.set(paneId, cb);
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
    pendingScriptRef.current.delete(paneId); // trmx-93: a pane closed before its script sourced
    readyCbsRef.current.delete(paneId);
    oscTitleCbsRef.current.delete(paneId);
    badgeCbsRef.current.delete(paneId);
    mirroredRef.current.delete(paneId);
    attachEpochRef.current.delete(paneId);
    // trmx-91: cancel this pane's pending activity timer and drop its debounce state (no stray fire
    // into a dead pane, no leaked ActivityState).
    const activityTimer = activityTimersRef.current.get(paneId);
    if (activityTimer !== undefined) clearTimeout(activityTimer);
    activityTimersRef.current.delete(paneId);
    activityStatesRef.current.delete(paneId);
    // trmx-99 (FR-7b): drop this pane's OSC 133 latch + marker cb + exit-flash (a closed pane leaves no
    // sticky source, no stale flash timer). The latch resets so a reused pane re-detects integration.
    osc133PanesRef.current.delete(paneId);
    promptMarkerCbsRef.current.delete(paneId);
    clearFlashFor(paneId);
    // trmx-98: drop this pane's find-bar state so a closed pane leaves no open bar / stale controller.
    searchControllersRef.current.delete(paneId);
    setOpenSearchPanes((prev) => {
      if (!prev.has(paneId)) return prev;
      const next = new Set(prev);
      next.delete(paneId);
      return next;
    });
    if (sessionId !== undefined && !opts?.alreadyExited) {
      seamsRef.current.closeSession(sessionId).catch((err: unknown) => {
        console.error("[termixion] close pty failed", err);
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
    activityState: (paneId) => activityStatesRef.current.get(paneId),
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
      const busy = paneIsBusy(activityStatesRef.current.get(paneId), tab.panes[paneId].activityVisible);
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

  // trmx-93 (FR-5): run `entry` in a fresh surface. The chosen script is stored in pendingScriptRef
  // keyed by the upcoming pane's (predictable) id SYNCHRONOUSLY before the creating dispatch — the
  // same nextPaneId requestNewTab/requestSplit seed pendingCwdRef with, so cwd inheritance survives
  // and the new pane's attach sources the script. For a split that won't fit we bail WITHOUT setting
  // the pending script, so a no-op split can't leave a stale entry for the next pane to pick up.
  const runScriptInSurface = (entry: ScriptEntry, surface: "tab" | "right" | "below") => {
    const s = stateRef.current;
    const upcoming = s.nextPaneId;
    const pending = Promise.resolve<{ sourceLine: string } | null>({ sourceLine: entry.sourceLine });
    if (surface === "tab") {
      pendingScriptRef.current.set(upcoming, pending);
      requestNewTab();
      return;
    }
    const tab = s.activeTabId !== null ? s.tabs.find((t) => t.tabId === s.activeTabId) : undefined;
    const treeDir: SplitDir = surface === "right" ? "row" : "column";
    if (!tab || !canSplitFocused(tab, treeDir, boundsRef.current, MIN_PANE_PX)) return; // won't fit
    pendingScriptRef.current.set(upcoming, pending);
    requestSplit(surface);
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
      const handle = handlesRef.current.get(tab.focusedPaneId);
      (handle?.terminal as unknown as { clear?: () => void } | undefined)?.clear?.();
    },
    // trmx-98 (FR-1.5): open the focused pane's find bar (or focus it if already open). The bar renders
    // as a pane-host child and registers its controller into searchControllersRef on mount.
    openSearch: () => {
      const tab = getActiveTab();
      if (!tab) return;
      const paneId = tab.focusedPaneId;
      const controller = searchControllersRef.current.get(paneId);
      if (controller) controller.focus();
      else setOpenSearchPanes((prev) => new Set(prev).add(paneId));
    },
    searchNext: () => {
      const tab = getActiveTab();
      if (tab) searchControllersRef.current.get(tab.focusedPaneId)?.next();
    },
    searchPrev: () => {
      const tab = getActiveTab();
      if (tab) searchControllersRef.current.get(tab.focusedPaneId)?.prev();
    },
    closeSearch: () => {
      const tab = getActiveTab();
      if (tab) searchControllersRef.current.get(tab.focusedPaneId)?.close();
    },
    openSettings: () => {
      invoke("open_settings_window", { section: null }).catch((err: unknown) =>
        console.error("[termixion] open settings failed", err),
      );
    },
    checkForUpdates: () => {
      invoke("open_settings_window", { section: "about" }).catch((err: unknown) =>
        console.error("[termixion] open settings (updates) failed", err),
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
      const sessionId = tab ? sessionsRef.current.get(tab.focusedPaneId) : undefined;
      if (sessionId !== undefined) {
        seamsRef.current.sendInput(sessionId, `${sourceLine}\r`).catch((err: unknown) =>
          console.error("[termixion] run script failed", err),
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
        // trmx-159: the 1 Hz name hint also reclassifies the current epoch — recovering a still-unknown
        // epoch and catching an in-epoch program takeover (name-only ⇒ partial-metadata fail-safe).
        const current = activityStatesRef.current.get(hit.paneId) ?? initialActivity();
        applyActivityTransition(
          hit.tab.tabId,
          hit.paneId,
          onClassifyMetadata(current, { name }, Date.now()),
        );
      }
    });
    const stopTabsAction = observeTabsAction((payload) => {
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

  // trmx-91: subscribe to session:activity — route each busy<->idle transition by sessionId into the
  // OWNING pane (the per-pane closure is the load-bearing scoping: a background pane's busy state
  // shows on THAT pane's line, never the focused one) and drive its debounce. Its OWN effect, dep'd
  // only on the stable seam. Independent of the setting: the debounce always runs; the render gate
  // (activityIndicatorOn) alone decides whether the resolved line paints, so toggling the setting
  // never desyncs the phase.
  useEffect(() => {
    return observeActivity((sessionId, busy, meta) => {
      const hit = paneBySessionId(stateRef.current, sessionId);
      if (!hit) return; // no pane owns this session (session-less/closed) — inert
      const current = activityStatesRef.current.get(hit.paneId) ?? initialActivity();
      // trmx-159 (weakens the trmx-99 latch): once a pane is OSC-133-owned, the OSC 133 machine OWNS
      // rawBusy — so IGNORE the poller's `busy` field (do not feed it to onBusyChange). But still
      // CONSUME its classification metadata: the poller's name-bearing rise classifies the epoch that
      // the `C` marker opened `unknown`. rawBusy stays provably with OSC 133; only the class is adopted.
      if (osc133PanesRef.current.has(hit.paneId)) {
        if (meta) {
          applyActivityTransition(hit.tab.tabId, hit.paneId, onClassifyMetadata(current, meta, Date.now()));
        }
        return;
      }
      // Poller-owned pane: the rise is born classified from the metadata (no ordering window).
      applyActivityTransition(hit.tab.tabId, hit.paneId, onBusyChange(current, busy, Date.now(), meta));
    });
  }, [observeActivity]);

  // trmx-159: the test-only I/O injection seams (production observes through useBackend directly).
  // Each drives the same ioObserversRef handlers as the live terminal wiring.
  useEffect(() => {
    if (!observeOutput && !observeInput) return;
    const stops: Array<() => void> = [];
    if (observeOutput) {
      stops.push(observeOutput((sessionId, byteLength) => ioObserversRef.current.output(sessionId, byteLength)));
    }
    if (observeInput) {
      stops.push(observeInput((sessionId, data) => ioObserversRef.current.input(sessionId, data)));
    }
    return () => stops.forEach((stop) => stop());
  }, [observeOutput, observeInput]);

  // trmx-101 (FR-9.4): the control-channel bridge. A request from the Rust socket routes through the SAME
  // command dispatcher as a keypress, builds the ls snapshot, or types into a pane; the reply goes back
  // via control_response. All App-owned state read from refs (out-of-render).
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
        buildLs: () =>
          buildLsSnapshot(
            stateRef.current.tabs,
            stateRef.current.activeTabId,
            (paneId) => storesRef.current.get(paneId)?.get() ?? null,
            paneBusy,
          ),
        sendText: (pane, text) => {
          const active = getActiveTab();
          const paneId = pane === "focused" ? active?.focusedPaneId : Number(pane);
          if (paneId === undefined || Number.isNaN(paneId)) return false;
          const sessionId = sessionsRef.current.get(paneId);
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
    return observeCloseRequested(() => {
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
      else if (key === "terminal.activityIndicator" && typeof value === "boolean") {
        setActivityIndicatorOn(value);
      }
      // trmx-151: keep the ⌘N hint toggle live (same boolean guard). Off strips the prefixes
      // without touching the keymap — the chords stay bound either way.
      else if (key === "tabs.showShortcutHints" && typeof value === "boolean") {
        setShortcutHintsOn(value);
      }
      // trmx-90/91: recompute the badge watermark AND the activity-line color on every theme event so
      // both repaint on a theme switch AND on a trmx-89 same-id hot-reload (the token changed under the
      // same id, review-1). Same untrusted-payload discipline as barPosition; resolveTheme is total.
      else if (key === "appearance.theme" && (isRegisteredThemeId(value) || isUserThemeIdShape(value))) {
        setBadgeColor(resolveTheme(value).terminal.badge);
        setBadgeOutlineColor(resolveTheme(value).color.bg.primary); // trmx-149: re-tint the stroke
        setActivityColor(activityColorFor(value));
        setActivityErrorColor(activityErrorColorFor(value)); // trmx-99: re-tint the exit-code flash
        setSearchColors(resolveTheme(value).terminal.search); // trmx-98: re-tint the find highlights
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
    // trmx-90: the badge editor (like a rename) owns the keyboard while open — suppress the terminal
    // grab so the ⇧⌘B input keeps focus; commit/cancel clears badgingPaneId → this re-runs.
    if (renamingTabId !== null || badgingPaneId !== null) return;
    if (activeFocusedPaneId === null) return;
    // trmx-98: an open find bar on the focused pane owns the keyboard — don't grab it back to the terminal.
    if (openSearchPanes.has(activeFocusedPaneId)) return;
    const terminal = handlesRef.current.get(activeFocusedPaneId)?.terminal;
    (terminal as unknown as { focus?: () => void } | undefined)?.focus?.();
  }, [state.activeTabId, activeFocusedPaneId, renamingTabId, badgingPaneId, openSearchPanes]);

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

  // Cleanup on unmount: a mid-drag unmount must not leave a queued frame to dispatch into a dead
  // reducer, and (trmx-91/99) no pending activity OR flash timer may fire a setState after unmount.
  useEffect(() => {
    const activityTimers = activityTimersRef.current;
    const flashTimers = activityFlashTimersRef.current;
    return () => {
      if (frameCancelRef.current) frameCancelRef.current();
      for (const timer of activityTimers.values()) clearTimeout(timer);
      activityTimers.clear();
      for (const timer of flashTimers.values()) clearTimeout(timer);
      flashTimers.clear();
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
      (handlesRef.current.get(p.paneId)?.terminal as unknown as { clearSelection?: () => void } | undefined)?.clearSelection?.();
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

  // trmx-81: the position class + the strip's axis. The JSX order NEVER changes (hosts first, strip
  // LAST): barLayoutFor's flex direction moves the bar; the keyed pane hosts stay put (keep-alive).
  const barLayout = barLayoutFor(barPosition);
  const labelOrientation = labelOrientationFor(barPosition, sideLabelOrientation);
  // trmx-90: `badgeColor` is now live state (updated on every appearance.theme event, incl. a same-id
  // hot-reload), not a per-render derive — see the useState above.

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
              {solved.panes.map(({ paneId, rect }) => {
                const pane = tab.panes[paneId];
                // trmx-90: the badge's narrow-pane threshold reads cols off the mounted terminal (a
                // localized cast, like the scrollbar's ScrollbarTerminalLike) with a sane fallback
                // before the first fit / under a headless stub. Reactive enough: a resize/split/badge
                // change re-renders App and re-reads it, and a badge only ever lands on a live
                // terminal. trmx-149: font SIZING no longer needs cell metrics — the iTerm2 fit-to-box
                // model runs on the pane rect itself (BadgeOverlay gets rect.width/height below).
                const metrics = handlesRef.current.get(paneId)?.terminal as unknown as
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
                    {/* trmx-91: the top-edge activity line (click-through, below the badge). Shown while
                        this pane is busy (its debounced activityVisible) OR flashing a failed command's
                        exit code (trmx-99), AND the setting is on. The flash paints the error color and
                        overrides the busy color (a new command clears the flash first). */}
                    <ActivityLineOverlay
                      visible={
                        activityIndicatorOn && (pane.activityVisible === true || flashingPanes.has(paneId))
                      }
                      color={flashingPanes.has(paneId) ? activityErrorColor : activityColor}
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
                      handlesRef.current.get(paneId)?.search &&
                      (() => {
                        const search = handlesRef.current.get(paneId)!.search;
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
                                handlesRef.current.get(paneId)?.terminal as unknown as
                                  | { focus?: () => void }
                                  | undefined
                              )?.focus?.();
                            }}
                            onRegister={(c) => {
                              if (c) searchControllersRef.current.set(paneId, c);
                              else searchControllersRef.current.delete(paneId);
                            }}
                          />
                        );
                      })()}
                  </div>
                );
              })}
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
    </main>
  );
}

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
