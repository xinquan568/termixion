// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-95 (FR-8): auto-copy the mouse selection to the clipboard, iTerm2-style. The correctness core
// is a PURE gesture machine over injected deps (no DOM, no real timers) — the subtlety is entirely in
// WHEN to copy: once, on selection END, never on the continuous onSelectionChange ticks xterm fires
// during a drag. A mouse selection copies on pointerup (DEFERRED a tick so xterm's final selection has
// settled), and ONLY if the gesture actually changed the selection (a click that leaves a pre-existing
// selection copies nothing). A keyboard/programmatic selection (no pointer down, e.g. Select-All)
// debounces then copies once. Empty selections never touch the clipboard (no clobber); identical
// consecutive text is not rewritten (dedup). Byte-identical to ⌘C — both call clipboard.selectionText.
//
// trmx-180 (reliability): three hardening rules on top of the trmx-95 semantics.
// (1) The dedup latch is BOUNDED — a fresh pointer gesture resets it and it expires after
//     `dedupWindowMs` — so re-selecting the same text after the pasteboard changed elsewhere always
//     writes; the latch only suppresses the genuine duplicate (a trailing same-text tick moments
//     after a completed copy).
// (2) Capture loss is a SOFT abort: `lostpointercapture` fires on EVERY captured release (after
//     pointerup per spec, but engine order is not guaranteed), so it defers its abort one tick and a
//     same-turn pointerup completes the gesture under either delivery order. `pointercancel` and
//     window blur remain immediate hard aborts.
// (3) The deferred copy prefers the LIVE selection (double/triple-click settle) but falls back to
//     the text captured at pointerup when streaming reflow cleared the selection in the gap.

/** An injectable one-shot timer: schedule `fn` after `ms`, returns a cancel. Real one uses setTimeout;
 * tests pass a controllable fake so the debounce/defer are deterministic (no vi.useFakeTimers). */
export type Schedule = (fn: () => void, ms: number) => () => void;

/** The real schedule (setTimeout-backed). */
export const realSchedule: Schedule = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export interface CopyOnSelectDeps {
  selectionText: () => string;
  hasSelection: () => boolean;
  writeClipboard: (text: string) => void;
  schedule: Schedule;
  /** Keyboard/programmatic debounce (default 150 ms). */
  debounceMs?: number;
  /** trmx-180: identical text dedups only within this window (default 1000 ms). */
  dedupWindowMs?: number;
  /** trmx-180: clock for the dedup window (default Date.now); injectable for tests. */
  now?: () => number;
}

export interface CopyOnSelectMachine {
  onPointerDown(): void;
  onSelectionChange(): void;
  onPointerUp(): void;
  /** pointercancel / window blur mid-drag — hard abort, never copy, never stick. */
  onCancel(): void;
  /**
   * trmx-180: lostpointercapture — a SOFT abort. Fired by the browser on every captured release
   * (normally after pointerup, but engine order is not guaranteed), so the abort defers one tick;
   * a same-turn onPointerUp cancels it and completes the gesture. A capture loss with no release
   * (capture steal) still aborts, one tick later.
   */
  onCaptureLost(): void;
  dispose(): void;
}

/** The pure gesture machine (no DOM). `attachCopyOnSelect` wires it to real events. */
export function createCopyOnSelect(deps: CopyOnSelectDeps): CopyOnSelectMachine {
  const { selectionText, hasSelection, writeClipboard, schedule } = deps;
  const debounceMs = deps.debounceMs ?? 150;
  const dedupWindowMs = deps.dedupWindowMs ?? 1000;
  const now = deps.now ?? Date.now;

  let dragging = false;
  let dirty = false; // did THIS drag change the selection?
  let lastCopied: string | null = null;
  let lastCopiedAt = 0; // trmx-180: the dedup latch expires `dedupWindowMs` after this
  let cancelDebounce: (() => void) | undefined;
  let cancelDeferred: (() => void) | undefined;
  let cancelSoftAbort: (() => void) | undefined;

  const liveText = () => (hasSelection() ? selectionText() : "");

  const copyIfNew = (fallback = "") => {
    // Prefer the live selection (word/line settle); fall back to the release-time capture when
    // streaming reflow cleared it in the deferred gap (trmx-180).
    const live = liveText();
    const text = live !== "" ? live : fallback;
    if (text === "") return; // empty → never clobbers
    if (text === lastCopied && now() - lastCopiedAt <= dedupWindowMs) return; // time-bounded dedup
    writeClipboard(text);
    lastCopied = text;
    lastCopiedAt = now();
  };

  const clearPending = () => {
    cancelDebounce?.();
    cancelDebounce = undefined;
    cancelDeferred?.();
    cancelDeferred = undefined;
    cancelSoftAbort?.();
    cancelSoftAbort = undefined;
  };

  return {
    onPointerDown() {
      dragging = true;
      dirty = false;
      lastCopied = null; // trmx-180: a fresh deliberate gesture always writes, even the same text
      clearPending(); // a fresh gesture supersedes any pending keyboard debounce
    },
    onSelectionChange() {
      if (dragging) {
        dirty = true; // a mid-drag tick — wait for pointerup, do not spam
        return;
      }
      // keyboard/programmatic: debounce, then copy once.
      cancelDebounce?.();
      cancelDebounce = schedule(() => {
        cancelDebounce = undefined;
        copyIfNew();
      }, debounceMs);
    },
    onPointerUp() {
      // The release wins over a pending soft abort — tolerates lostpointercapture-before-pointerup.
      cancelSoftAbort?.();
      cancelSoftAbort = undefined;
      if (!dragging) return; // a stray pointerup with no matching down
      dragging = false;
      const changed = dirty;
      dirty = false;
      if (!changed) return; // the gesture left the selection unchanged → copy nothing (no stale re-copy)
      const captured = liveText(); // trmx-180: the release-time text, the reflow fallback
      // Defer one tick so xterm's FINAL selection (word/line on double/triple-click; a late tick) settles.
      cancelDeferred?.();
      cancelDeferred = schedule(() => {
        cancelDeferred = undefined;
        copyIfNew(captured);
      }, 0);
    },
    onCancel() {
      cancelSoftAbort?.();
      cancelSoftAbort = undefined;
      dragging = false;
      dirty = false; // abort — no copy, never stuck "dragging"
    },
    onCaptureLost() {
      if (!dragging || cancelSoftAbort) return; // after a release (or duplicate) — benign, by contract
      cancelSoftAbort = schedule(() => {
        cancelSoftAbort = undefined;
        dragging = false;
        dirty = false; // a capture loss with no release — abort exactly like onCancel, one tick later
      }, 0);
    },
    dispose() {
      clearPending();
    },
  };
}

/** xterm's selection-change subscription (returns a disposable). */
export interface SelectionTerminalLike {
  getSelection(): string;
  hasSelection(): boolean;
  onSelectionChange(handler: () => void): { dispose(): void };
}

/**
 * Wire the gesture machine to a pane: pointerdown/up/cancel on the host (with POINTER CAPTURE so the
 * matching pointerup/cancel arrive even when the release lands outside the host), a window `blur` to
 * abort a mid-drag, and xterm's `onSelectionChange`. Returns a teardown removing all of them.
 */
export function attachCopyOnSelect(
  host: HTMLElement,
  terminal: SelectionTerminalLike,
  writeClipboard: (text: string) => void,
  schedule: Schedule = realSchedule,
): () => void {
  const machine = createCopyOnSelect({
    selectionText: () => terminal.getSelection(),
    hasSelection: () => terminal.hasSelection(),
    writeClipboard,
    schedule,
  });

  const onPointerUp = () => machine.onPointerUp();
  const onCancel = () => machine.onCancel();
  // trmx-180: lostpointercapture fires on EVERY captured release — soft abort, not a hard cancel,
  // so the copy survives regardless of the engine's {pointerup, lostpointercapture} order.
  const onCaptureLost = () => machine.onCaptureLost();

  // When pointer capture is unavailable, a release/cancel OUTSIDE the host would never reach the host
  // listeners — leaving the gesture stuck "dragging". So we fall back to one-shot document-level
  // pointerup/pointercancel that end the gesture wherever the pointer goes (review finding 1).
  const doc = host.ownerDocument;
  let clearDocFallback: (() => void) | undefined;
  const installDocFallback = () => {
    if (!doc || clearDocFallback) return;
    const end = (run: () => void) => () => {
      clearDocFallback?.();
      run();
    };
    const onDocUp = end(onPointerUp);
    const onDocCancel = end(onCancel);
    doc.addEventListener("pointerup", onDocUp, true);
    doc.addEventListener("pointercancel", onDocCancel, true);
    clearDocFallback = () => {
      doc.removeEventListener("pointerup", onDocUp, true);
      doc.removeEventListener("pointercancel", onDocCancel, true);
      clearDocFallback = undefined;
    };
  };

  const onPointerDown = (ev: PointerEvent) => {
    machine.onPointerDown();
    clearDocFallback?.(); // a fresh gesture supersedes a leftover fallback
    let captured = false;
    try {
      host.setPointerCapture(ev.pointerId); // deliver pointerup/cancel even on a release outside the host
      captured = true;
    } catch {
      captured = false; // jsdom / old engine
    }
    if (!captured) installDocFallback();
  };

  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointerup", onPointerUp);
  host.addEventListener("pointercancel", onCancel);
  host.addEventListener("lostpointercapture", onCaptureLost);
  const win = doc?.defaultView;
  win?.addEventListener("blur", onCancel);
  const selSub = terminal.onSelectionChange(() => machine.onSelectionChange());

  return () => {
    host.removeEventListener("pointerdown", onPointerDown);
    host.removeEventListener("pointerup", onPointerUp);
    host.removeEventListener("pointercancel", onCancel);
    host.removeEventListener("lostpointercapture", onCaptureLost);
    win?.removeEventListener("blur", onCancel);
    clearDocFallback?.();
    selSub.dispose();
    machine.dispose();
  };
}
