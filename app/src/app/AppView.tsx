// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254 (T8): App's view tree. A MODULE-SCOPE component — that matters far more than the line
// count. The keyed tab hosts and pane hosts live inside this tree, and React remounts a subtree when
// its component identity changes. Defining this inside App() would give it a fresh identity every
// render, remounting every terminal and reopening every PTY. At module scope the identity is stable
// and the keys and element types are unchanged, so reconciliation behaves exactly as before. The
// existing `recorder.unmounts` keep-alive assertions are what prove it.
//
// Props are flat and GENERATED from the compiler's own type for each symbol the tree reads. A
// hand-written prop list is precisely what went wrong repeatedly while planning this.

import { AiSessionCounter } from "../chrome/AiSessionCounter";
import { ConfigWarningsBadge } from "../chrome/ConfigWarningsBadge";
import { log } from "../ipc/logSink";
import { FALLBACK_BADGE_COLS } from "../panes/appConstants";
import { shouldFocusOnHover } from "../panes/focusFollowsMouse";
import { FindBar } from "../search/FindBar";
import { listThemes } from "../theme/registry";
import {
  useEffect,
  useRef,
  useState,
  type ActionDispatch,
  type Dispatch,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { BarLayout } from "../tabs/barLayout";
import type { ScriptEntry } from "../scripts/scriptsBackend";
import type { PaneRuntimes } from "./paneRuntime";
import { activeDividerSegments, dividerKey } from "../panes/paneChrome";
import { CommandPalette } from "../commands/CommandPalette";
import type { Command } from "../commands/registry";
import type { CommandContext } from "../commands/registry";
import type { Dispatcher } from "../commands/dispatch";
import { TitleBar } from "../chrome/TitleBar";
import type { AiSession } from "../chrome/aiSessionBuckets";
import { ActivityLineOverlay } from "../panes/ActivityLineOverlay";
import { BadgeOverlay } from "../panes/BadgeOverlay";
import { ConfirmCloseDialog } from "../panes/ConfirmCloseDialog";
import type { DropZone } from "../panes/dropZone";
import { solveRects, type DividerRect, type PaneId, type Rect, type SplitDir } from "../panes/layoutTree";
import { ScriptPicker } from "../scripts/ScriptPicker";
import type { TabBarPosition } from "../store/settingsStore";
import { TabStrip } from "../tabs/TabStrip";

import { TerminalView } from "../terminal/TerminalView";
import { UpdateAuthorityHost } from "../update/UpdateAuthorityHost";
import type { PendingClose } from "./closeContracts";
import type { PaneRuntime } from "./paneRuntime";
import type { TabsAction, TabsState } from "../tabs/tabState";
import type { PromptTransition } from "../terminal/osc133";
import type { TerminalHandle } from "../terminal/mountTerminal";
import type { CwdStore } from "../terminal/osc7";

export type AppViewProps = {
  activeTitle: string | undefined;
  activityErrorColor: string;
  activityIndicatorOn: boolean;
  activityIsDark: boolean;
  aiCounterOn: boolean;
  aiSessions: AiSession[];
  badgeColor: string;
  badgeFor: (tabId: number, paneId: PaneId) => (badge: string | null) => void;
  badgeOutlineColor: string;
  badgingPaneId: number | null;
  badgingRef: RefObject<number | null>;
  barLayout: BarLayout;
  barPosition: TabBarPosition;
  bounds: Rect;
  cancelBadge: () => void;
  cancelPendingClose: () => void;
  cancelRename: () => void;
  commandCtxRef: RefObject<CommandContext>;
  commandsRef: RefObject<Command[]>;
  commitBadge: (paneId: PaneId, value: string) => void;
  commitRename: (tabId: number, value: string) => void;
  confirmPendingClose: (dontAskAgain: boolean) => void;
  contentRef: RefObject<HTMLDivElement | null>;
  dispatch: ActionDispatch<[action: TabsAction]>;
  dispatcherRef: RefObject<Dispatcher | null>;
  dragDir: SplitDir | null;
  dragRef: RefObject<{ pointerId: number; tabId: number; path: DividerRect["path"]; dir: SplitDir; bounds: Rect; grabOffset: number; contentLeft: number; contentTop: number; } | null>;
  dropPreview: { paneId: PaneId; zone: DropZone; } | null;
  ffmRef: RefObject<boolean>;
  flashingPanes: Set<number>;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  keymap: Record<string, string>;
  labelOrientation: "horizontal" | "vertical";
  lastPointerRef: RefObject<{ x: number; y: number; } | null>;
  onDividerDoubleClick: (tabId: number, path: DividerRect["path"]) => (e: MouseEvent) => void;
  onDividerPointerCancel: (e: PointerEvent) => void;
  onDividerPointerDown: (tabId: number, d: DividerRect) => (e: PointerEvent) => void;
  onDividerPointerMove: (e: PointerEvent) => void;
  onDividerPointerUp: (e: PointerEvent) => void;
  onPaneClickCapture: (e: MouseEvent) => void;
  onPanePointerCancel: (e: PointerEvent) => void;
  onPanePointerDownCapture: (tabId: number, paneId: PaneId) => (e: PointerEvent) => void;
  onPanePointerMoveCapture: (e: PointerEvent) => void;
  onPanePointerUpCapture: (e: PointerEvent) => void;
  openSearchPanes: Set<number>;
  openSearchRef: RefObject<Set<number>>;
  oscTitleFor: (tabId: number, paneId: PaneId) => (title: string) => void;
  paneDragging: boolean;
  pendingClose: PendingClose | null;
  pendingCloseRef: RefObject<PendingClose | null>;
  pickupRef: RefObject<{ pointerId: number; tabId: number; paneId: PaneId; originX: number; originY: number; active: boolean; } | null>;
  promptMarkerFor: (tabId: number, paneId: PaneId) => (t: PromptTransition) => void;
  readyFor: (tabId: number, paneId: PaneId) => (handle: TerminalHandle) => void;
  renamingRef: RefObject<number | null>;
  renamingTabId: number | null;
  requestCloseTab: (tabId: number) => void;
  requestNewTab: () => void;
  runScriptInSurface: (entry: ScriptEntry, surface: "tab" | "right" | "below") => void;
  runtimesRef: RefObject<PaneRuntimes>;
  scriptPickerRef: RefObject<"right" | "tab" | "below" | null>;
  scriptPickerRequest: "right" | "tab" | "below" | null;
  searchColors: { match: string; activeMatch: string; };
  setOpenSearchPanes: Dispatch<SetStateAction<Set<number>>>;
  setPaneField: <K extends keyof PaneRuntime>(paneId: PaneId, field: K, value: PaneRuntime[K]) => void;
  setScriptPickerRequest: Dispatch<SetStateAction<"right" | "tab" | "below" | null>>;
  setShowPalette: Dispatch<SetStateAction<boolean>>;
  shortcutHintsOn: boolean;
  showPalette: boolean;
  startRename: (tabId: number) => void;
  state: TabsState;
  storeFor: (paneId: PaneId) => CwdStore;
};

export function AppView(props: AppViewProps) {
  const {
    activeTitle,
    activityErrorColor,
    activityIndicatorOn,
    activityIsDark,
    aiCounterOn,
    aiSessions,
    badgeColor,
    badgeFor,
    badgeOutlineColor,
    badgingPaneId,
    badgingRef,
    barLayout,
    barPosition,
    bounds,
    cancelBadge,
    cancelPendingClose,
    cancelRename,
    commandCtxRef,
    commandsRef,
    commitBadge,
    commitRename,
    confirmPendingClose,
    contentRef,
    dispatch,
    dispatcherRef,
    dragDir,
    dragRef,
    dropPreview,
    ffmRef,
    flashingPanes,
    invoke,
    keymap,
    labelOrientation,
    lastPointerRef,
    onDividerDoubleClick,
    onDividerPointerCancel,
    onDividerPointerDown,
    onDividerPointerMove,
    onDividerPointerUp,
    onPaneClickCapture,
    onPanePointerCancel,
    onPanePointerDownCapture,
    onPanePointerMoveCapture,
    onPanePointerUpCapture,
    openSearchPanes,
    openSearchRef,
    oscTitleFor,
    paneDragging,
    pendingClose,
    pendingCloseRef,
    pickupRef,
    promptMarkerFor,
    readyFor,
    renamingRef,
    renamingTabId,
    requestCloseTab,
    requestNewTab,
    runScriptInSurface,
    runtimesRef,
    scriptPickerRef,
    scriptPickerRequest,
    searchColors,
    setOpenSearchPanes,
    setPaneField,
    setScriptPickerRequest,
    setShowPalette,
    shortcutHintsOn,
    showPalette,
    startRename,
    state,
    storeFor,
  } = props;
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
