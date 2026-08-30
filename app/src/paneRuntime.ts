// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-248 (grill H6 / Red flag 4): the runtime identity of a pane, in ONE record.
//
// App.tsx used to keep this across fifteen parallel `useRef(new Map<PaneId, …>)` containers, kept
// consistent only by `disposePaneResources` remembering to clear each one. Every pane feature added
// a map at the top of the component and a delete line at the bottom, and nothing enforced the
// pairing — the shotgun-surgery shape the grill report named.
//
// Why this file lives at app/src/ root rather than in panes/, which is where #248 suggests: the
// record holds `TerminalHandle`, `CwdStore` and `PromptTransition` (terminal/, L3) and
// `SearchController` (search/, L4), while `panes/` is L1 under trmx-247's layering gate — and that
// rule covers type-only imports. Root files are L6 and may import anything, so this is the home that
// needs no new zone.
//
// TEARDOWN IS BEHAVIOUR, NOT BOOKKEEPING. `dispose` clears both timers and returns the session id
// for the caller to close; it deliberately does NOT:
//   * touch `handle.dispose()` — TerminalView's effect cleanup owns that, and doing it here would
//     tear the terminal down twice;
//   * call the backend — transport does not belong in a state container;
//   * touch React state — this lives in a ref, so `setOpenSearchPanes` / `setFlashingPanes` stay
//     App's to perform. `dispose` returns what App still has to do rather than doing it.
import type { ActivityState } from "./panes/activityLine";
import type { PaneId } from "./panes/layoutTree";
import type { SearchController } from "./search/FindBar";
import type { TerminalHandle } from "./terminal/mountTerminal";
import type { PromptTransition } from "./terminal/osc133";
import type { CwdStore } from "./terminal/osc7";

/** Everything App tracks about one live pane, out of render. */
/**
 * A pending timer's id. The DOM lib types `setTimeout` as returning `number` and `@types/node`
 * types it as returning `Timeout`; both resolutions write this record (App.tsx and the unit test),
 * so it holds either. Everything we do with it is hand it back to `clearTimeout`, which takes both.
 */
export type TimerId = ReturnType<typeof setTimeout> | number;

export interface PaneRuntime {
  /** OSC 7 cwd store — the one field always present, so it is not optional. */
  cwd: CwdStore;
  /** The mounted terminal, once TerminalView reports ready. */
  handle?: TerminalHandle;
  /** The attached backend session. `undefined` means NOT ATTACHED — distinct from "no pane". */
  sessionId?: number;
  /** cwd to seed the open with (trmx-74: a new tab inherits the active pane's directory). */
  pendingCwd?: string;
  /** trmx-93: a startup script resolving in flight; consumed on its own path, not at close. */
  pendingScript?: Promise<{ sourceLine: string } | null>;
  /** Bumped by each onReady; a resolution whose epoch is stale is discarded (StrictMode remount). */
  attachEpoch: number;
  onReady?: (handle: TerminalHandle) => void;
  onOscTitle?: (title: string) => void;
  onBadge?: (badge: string | null) => void;
  onPromptMarker?: (transition: PromptTransition) => void;
  /** trmx-91 activity debounce state. */
  activity?: ActivityState;
  activityTimer?: TimerId;
  /** trmx-99 exit-flash timer. */
  flashTimer?: TimerId;
  /** trmx-99: shell-integration latch. Was a `Set` membership; a boolean field says the same thing. */
  osc133: boolean;
  /** trmx-98: the pane's find bar, while one is mounted. */
  search?: SearchController;
}

/** What the caller must still do after a pane's runtime is torn down. */
export interface DisposeOutcome {
  /** The attached session, if there was one — captured BEFORE the record was dropped. */
  sessionId?: number;
}

export interface PaneRuntimes {
  get(paneId: PaneId): PaneRuntime | undefined;
  /** Create the record for a NEW pane. Idempotent: an existing record is returned untouched. */
  ensure(paneId: PaneId, cwd: CwdStore): PaneRuntime;
  /** Clear both timers, drop the record, and report the session the caller must close. */
  dispose(paneId: PaneId): DisposeOutcome;
  /**
   * Clear every pane's timers WITHOUT dropping any record.
   *
   * Deliberately not "disposeAll": React StrictMode replays an effect's cleanup while the component
   * is still mounted, so App's unmount effect runs on a LIVE app. Dropping records there would wipe
   * pending cwd, cached callbacks, session ids and attach epochs immediately before the remount.
   * The pre-trmx-248 code cleared only the two timer maps for exactly this reason.
   */
  clearAllTimers(): void;
}

export function createPaneRuntimes(): PaneRuntimes {
  const byPane = new Map<PaneId, PaneRuntime>();

  const clearTimers = (runtime: PaneRuntime) => {
    if (runtime.activityTimer !== undefined) clearTimeout(runtime.activityTimer);
    if (runtime.flashTimer !== undefined) clearTimeout(runtime.flashTimer);
    runtime.activityTimer = undefined;
    runtime.flashTimer = undefined;
  };

  return {
    get: (paneId) => byPane.get(paneId),
    ensure(paneId, cwd) {
      const existing = byPane.get(paneId);
      if (existing) return existing;
      const created: PaneRuntime = { cwd, attachEpoch: 0, osc133: false };
      byPane.set(paneId, created);
      return created;
    },
    dispose(paneId) {
      const runtime = byPane.get(paneId);
      if (!runtime) return {};
      const { sessionId } = runtime; // captured BEFORE the drop — App still has to close it
      clearTimers(runtime);
      byPane.delete(paneId);
      return { sessionId };
    },
    clearAllTimers() {
      for (const runtime of byPane.values()) clearTimers(runtime);
    },
  };
}
