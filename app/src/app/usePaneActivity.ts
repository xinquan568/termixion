// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: the per-pane activity concern — the trmx-91 debounce, the trmx-99 exit flash, and the
// trmx-159 I/O classifier. Pure logic: no state, no refs, no effects. The root keeps E07/E08 (and
// E05's title-hint subscription) registered with their dependency arrays unchanged and calls the
// operations returned here, so effect order is preserved by construction.

import type { Dispatch } from "react";
import { FLASH_MS, shouldFlash } from "../panes/activityFlash";
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
  type ActivityTransition,
} from "../panes/activityLine";
import type { PaneId } from "../panes/layoutTree";
import { paneBySessionId, type TabsAction, type TabsState } from "../tabs/tabState";
import type { PromptTransition } from "../terminal/osc133";
import type { PaneRuntime, PaneRuntimes } from "./paneRuntime";

export type IoObservers = {
  output: (sessionId: number, byteLength: number) => void;
  input: (sessionId: number, data: string) => void;
};

export type PaneActivityDeps = {
  paneOf: (paneId: PaneId) => PaneRuntime;
  setPaneField: <K extends keyof PaneRuntime>(paneId: PaneId, field: K, value: PaneRuntime[K]) => void;
  runtimesRef: { current: PaneRuntimes };
  ioObserversRef: { current: IoObservers };
  stateRef: { current: TabsState };
  dispatch: Dispatch<TabsAction>;
  setFlashingPanes: (update: (prev: Set<PaneId>) => Set<PaneId>) => void;
  observeActivity: (on: (sessionId: number, busy: boolean, meta?: ActivityMeta) => void) => () => void;
  observeOutput?: (on: (sessionId: number, byteLength: number) => void) => () => void;
  observeInput?: (on: (sessionId: number, data: string) => void) => () => void;
  observeTitleHint: (on: (sessionId: number, name: string) => void) => () => void;
};

export type PaneActivity = {
  applyActivityTransition: (tabId: number, paneId: PaneId, t: ActivityTransition) => void;
  startFlash: (paneId: PaneId) => void;
  clearFlashFor: (paneId: PaneId) => void;
  promptMarkerFor: (tabId: number, paneId: PaneId) => (t: PromptTransition) => void;
  /** E07's body — the `session:activity` subscription. Returns its teardown. */
  onSessionActivity: () => () => void;
  /** E08's body — the trmx-159 I/O observers. Returns its teardown (or undefined when unseamed). */
  installIoObservers: () => (() => void) | undefined;
  /** E05's title-hint subscription. Returns its teardown. */
  onTitleHint: () => () => void;
};

export function usePaneActivity(deps: PaneActivityDeps): PaneActivity {
  const {
    paneOf, setPaneField, runtimesRef, ioObserversRef, stateRef, dispatch,
    setFlashingPanes, observeActivity, observeOutput, observeInput, observeTitleHint,
  } = deps;

  const applyActivityTransition = (
    tabId: number,
    paneId: PaneId,
    { state, deadline }: ActivityTransition,
  ) => {
    setPaneField(paneId, "activity", state);
    const prior = runtimesRef.current.get(paneId)?.activityTimer;
    if (prior !== undefined) {
      clearTimeout(prior);
      setPaneField(paneId, "activityTimer", undefined);
    }
    const now = Date.now();
    // trmx-159: fold the class-layer deadline (unknown-fallback / light-off / window-close) with the
    // phase deadline into the single per-pane timer — arm to whichever fires first.
    const classAt = classDeadline(state, now);
    const armAt =
      deadline === null ? classAt : classAt === null ? deadline : Math.min(deadline, classAt);
    if (armAt !== null) {
      const timer = setTimeout(() => {
        setPaneField(paneId, "activityTimer", undefined);
        const current = runtimesRef.current.get(paneId)?.activity ?? initialActivity();
        applyActivityTransition(tabId, paneId, onDeadline(current, Date.now()));
      }, Math.max(0, armAt - now));
      setPaneField(paneId, "activityTimer", timer);
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
      const current = runtimesRef.current.get(hit.paneId)?.activity ?? initialActivity();
      applyActivityTransition(hit.tab.tabId, hit.paneId, onActivityOutput(current, byteLength, Date.now()));
    },
    input: (sessionId, data) => {
      const hit = paneBySessionId(stateRef.current, sessionId);
      if (!hit) return;
      const current = runtimesRef.current.get(hit.paneId)?.activity ?? initialActivity();
      applyActivityTransition(hit.tab.tabId, hit.paneId, onActivityInput(current, data, Date.now()));
    },
  };

  // trmx-99 (FR-7b): start / cancel a pane's exit-code flash. The flashing set drives the overlay
  // re-render; the timer clears it after FLASH_MS. A new command (C) cancels a stale flash.
  const startFlash = (paneId: PaneId) => {
    const prior = runtimesRef.current.get(paneId)?.flashTimer;
    if (prior !== undefined) clearTimeout(prior);
    setFlashingPanes((prev) => new Set(prev).add(paneId));
    const timer = setTimeout(() => {
      setPaneField(paneId, "flashTimer", undefined);
      setFlashingPanes((prev) => {
        if (!prev.has(paneId)) return prev;
        const next = new Set(prev);
        next.delete(paneId);
        return next;
      });
    }, FLASH_MS);
    setPaneField(paneId, "flashTimer", timer);
  };
  const clearFlashFor = (paneId: PaneId) => {
    const prior = runtimesRef.current.get(paneId)?.flashTimer;
    if (prior !== undefined) {
      clearTimeout(prior);
      setPaneField(paneId, "flashTimer", undefined);
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
    let cb = paneOf(paneId).onPromptMarker;
    if (!cb) {
      cb = (transition) => {
        setPaneField(paneId, "osc133", true);
        if (transition.busy) clearFlashFor(paneId); // a new command wins over a leftover flash
        if (transition.busyChanged) {
          const current = runtimesRef.current.get(paneId)?.activity ?? initialActivity();
          applyActivityTransition(tabId, paneId, onBusyChange(current, transition.busy, Date.now()));
        }
        if (shouldFlash(transition.exitCode)) startFlash(paneId);
      };
      paneOf(paneId).onPromptMarker = cb;
    }
    return cb;
  };

  // Dispose one pane's resources: drop all its paneId-keyed maps and close its PTY (unless the
  // shell already exited). Shared by pane-close, pty:exited, and whole-tab close — one path, no leak.

  const onSessionActivity = () => {
    return observeActivity((sessionId, busy, meta) => {
      const hit = paneBySessionId(stateRef.current, sessionId);
      if (!hit) return; // no pane owns this session (session-less/closed) — inert
      // trmx-190: the FOREGROUND counting slot — set from the metadata-bearing rise (the 250 ms
      // path the counter's freshness rides on), cleared on the fall (the AI exited/suspended).
      // Deliberately BEFORE the OSC-133 carve-out: that latch owns rawBusy, not foreground
      // tracking, so a latched pane still counts. The reducer's === no-op absorbs redundancy.
      if (busy && meta?.name !== undefined) {
        dispatch({ kind: "setForeground", tabId: hit.tab.tabId, paneId: hit.paneId, name: meta.name });
      } else if (!busy) {
        dispatch({ kind: "setForeground", tabId: hit.tab.tabId, paneId: hit.paneId, name: null });
      }
      const current = runtimesRef.current.get(hit.paneId)?.activity ?? initialActivity();
      // trmx-159 (weakens the trmx-99 latch): once a pane is OSC-133-owned, the OSC 133 machine OWNS
      // rawBusy — so IGNORE the poller's `busy` field (do not feed it to onBusyChange). But still
      // CONSUME its classification metadata: the poller's name-bearing rise classifies the epoch that
      // the `C` marker opened `unknown`. rawBusy stays provably with OSC 133; only the class is adopted.
      if ((runtimesRef.current.get(hit.paneId)?.osc133 ?? false)) {
        if (meta) {
          applyActivityTransition(hit.tab.tabId, hit.paneId, onClassifyMetadata(current, meta, Date.now()));
        }
        return;
      }
      // Poller-owned pane: the rise is born classified from the metadata (no ordering window).
      applyActivityTransition(hit.tab.tabId, hit.paneId, onBusyChange(current, busy, Date.now(), meta));
    });
  };

  const installIoObservers = () => {
    if (!observeOutput && !observeInput) return;
    const stops: Array<() => void> = [];
    if (observeOutput) {
      stops.push(observeOutput((sessionId, byteLength) => ioObserversRef.current.output(sessionId, byteLength)));
    }
    if (observeInput) {
      stops.push(observeInput((sessionId, data) => ioObserversRef.current.input(sessionId, data)));
    }
    return () => stops.forEach((stop) => stop());
  };

  const onTitleHint = () => {
    return observeTitleHint((sessionId, name) => {
      const hit = paneBySessionId(stateRef.current, sessionId);
      if (hit) {
        dispatch({
          kind: "setTitleSource",
          tabId: hit.tab.tabId,
          paneId: hit.paneId,
          source: "process",
          value: name,
        });
        // trmx-190: the 1 Hz hint also CORRECTS the foreground counting slot (a missed rise or an
        // in-session program takeover). Non-AI names simply bucket to null downstream; the
        // reducer's === no-op absorbs the steady-state stream. An empty name clears the slot.
        dispatch({
          kind: "setForeground",
          tabId: hit.tab.tabId,
          paneId: hit.paneId,
          name: name === "" ? null : name,
        });
        // trmx-159: the 1 Hz name hint also reclassifies the current epoch — recovering a still-unknown
        // epoch and catching an in-epoch program takeover (name-only ⇒ partial-metadata fail-safe).
        const current = runtimesRef.current.get(hit.paneId)?.activity ?? initialActivity();
        applyActivityTransition(
          hit.tab.tabId,
          hit.paneId,
          onClassifyMetadata(current, { name }, Date.now()),
        );
      }
    });
  };

  return {
    applyActivityTransition, startFlash, clearFlashFor, promptMarkerFor,
    onSessionActivity, installIoObservers, onTitleHint,
  };
}
