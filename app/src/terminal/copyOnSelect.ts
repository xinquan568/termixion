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
}

export interface CopyOnSelectMachine {
  onPointerDown(): void;
  onSelectionChange(): void;
  onPointerUp(): void;
  /** pointercancel / lostpointercapture / window blur mid-drag — abort, never copy, never stick. */
  onCancel(): void;
  dispose(): void;
}

/** The pure gesture machine (no DOM). `attachCopyOnSelect` wires it to real events. */
export function createCopyOnSelect(deps: CopyOnSelectDeps): CopyOnSelectMachine {
  const { selectionText, hasSelection, writeClipboard, schedule } = deps;
  const debounceMs = deps.debounceMs ?? 150;

  let dragging = false;
  let dirty = false; // did THIS drag change the selection?
  let lastCopied: string | null = null;
  let cancelDebounce: (() => void) | undefined;
  let cancelDeferred: (() => void) | undefined;

  const copyIfNew = () => {
    if (!hasSelection()) return; // empty → never clobbers
    const text = selectionText();
    if (text === "" || text === lastCopied) return; // empty / dedup
    writeClipboard(text);
    lastCopied = text;
  };

  const clearPending = () => {
    cancelDebounce?.();
    cancelDebounce = undefined;
    cancelDeferred?.();
    cancelDeferred = undefined;
  };

  return {
    onPointerDown() {
      dragging = true;
      dirty = false;
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
      if (!dragging) return; // a stray pointerup with no matching down
      dragging = false;
      const changed = dirty;
      dirty = false;
      if (!changed) return; // the gesture left the selection unchanged → copy nothing (no stale re-copy)
      // Defer one tick so xterm's FINAL selection (word/line on double/triple-click; a late tick) settles.
      cancelDeferred?.();
      cancelDeferred = schedule(() => {
        cancelDeferred = undefined;
        copyIfNew();
      }, 0);
    },
    onCancel() {
      dragging = false;
      dirty = false; // abort — no copy, never stuck "dragging"
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
  host.addEventListener("lostpointercapture", onCancel);
  const win = doc?.defaultView;
  win?.addEventListener("blur", onCancel);
  const selSub = terminal.onSelectionChange(() => machine.onSelectionChange());

  return () => {
    host.removeEventListener("pointerdown", onPointerDown);
    host.removeEventListener("pointerup", onPointerUp);
    host.removeEventListener("pointercancel", onCancel);
    host.removeEventListener("lostpointercapture", onCancel);
    win?.removeEventListener("blur", onCancel);
    clearDocFallback?.();
    selSub.dispose();
    machine.dispose();
  };
}
