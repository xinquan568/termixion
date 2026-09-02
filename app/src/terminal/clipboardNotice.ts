// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-252 (L11, sub-task T3.4): the per-pane OSC 52 CLIPBOARD NOTICE — a small transient label
// that tells the user a program in this pane just asked to set the clipboard. Without it an OSC 52
// write is completely invisible: a remote program can replace what you are about to paste and
// nothing on screen changes.
//
// Three deliberate properties:
//
//   1. It claims only an ACCEPTED REQUEST, never a completed clipboard change. The native write
//      crosses Tauri IPC and swallows async failure (nativeClipboard.ts), so "clipboard set" would
//      assert something this code cannot observe.
//   2. It is VISUALLY DISTINCT from the two existing pane overlays: the OSC 1337 badge is a large
//      translucent watermark in the TOP-RIGHT (BadgeOverlay/.tx-badge) and the activity line is a
//      2px bar along the TOP edge (.tx-activity-line). This is a small opaque pill in the
//      BOTTOM-LEFT, so none of the three can be mistaken for another.
//   3. Repeated requests COALESCE behind ONE timer. A program that yanks in a loop (nvim over ssh,
//      a script) would otherwise stack a node and a timer per sequence; here the first request
//      opens the window and every request inside it is absorbed. `dispose()` clears the pending
//      timer and removes the node, so a pane that unmounts mid-window leaves nothing behind.
//
// Attached as a DOM overlay on the terminal host (the scrollbar idiom, attachScrollbar) rather than
// as a React component: the host is per-pane already, and TerminalView owns its lifetime — no App
// prop fan-out, and no re-render path for something that is pure chrome. The look lives in the
// `.tx-clipboard-notice` CSS (index.css); only `pointer-events: none` is inline, because it is the
// load-bearing click-through guarantee and jsdom (css:false under Vitest) can only see it there.

/** How long one notice stays up, in ms, measured from the FIRST request in a burst. */
export const CLIPBOARD_NOTICE_MS = 1800;

/**
 * The notice wording. An accepted REQUEST — see property (1) in the header: nothing here can
 * confirm the pasteboard actually changed, so nothing here may say it did.
 */
export const CLIPBOARD_NOTICE_TEXT = "Clipboard write request accepted";

/** The timer seam (injected in tests so coalescing/teardown are asserted, not waited for). */
export interface ClipboardNoticeTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface ClipboardNoticeOptions {
  /** Visible duration in ms; defaults to {@link CLIPBOARD_NOTICE_MS}. */
  durationMs?: number;
  /** Timer seam; defaults to the host window's `setTimeout`/`clearTimeout`. */
  timers?: ClipboardNoticeTimers;
  /** Document used to create the node; defaults to the host's own. */
  document?: Document;
}

export interface ClipboardNoticeHandle {
  /** One accepted OSC 52 write request. Inside a live window this is absorbed (see header). */
  notify(): void;
  /** Remove the notice and clear any pending timer. Idempotent; `notify()` after it is inert. */
  dispose(): void;
}

/** The real timer seam — a lazily-read `window`, so the module can be imported anywhere. */
function windowTimers(): ClipboardNoticeTimers {
  return {
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id),
  };
}

/**
 * Mount the clipboard notice on `host`. Nothing renders until the first {@link
 * ClipboardNoticeHandle.notify}; the node is created then and removed when the window closes, so
 * a pane that never sees an OSC 52 write carries no extra DOM at all.
 */
export function attachClipboardNotice(
  host: HTMLElement,
  options: ClipboardNoticeOptions = {},
): ClipboardNoticeHandle {
  const doc = options.document ?? host.ownerDocument;
  const timers = options.timers ?? windowTimers();
  const durationMs = options.durationMs ?? CLIPBOARD_NOTICE_MS;

  let node: HTMLElement | undefined;
  let timerId: number | undefined;
  let disposed = false;

  const clear = () => {
    if (timerId !== undefined) {
      timers.clearTimeout(timerId);
      timerId = undefined;
    }
    node?.remove();
    node = undefined;
  };

  return {
    notify() {
      if (disposed) return;
      // COALESCE: a live window absorbs the request whole — no second node, no second timer, and
      // no extension of the window either (one burst = one notice, however long the burst runs).
      if (timerId !== undefined) return;
      const el = doc.createElement("div");
      el.className = "tx-clipboard-notice";
      el.dataset.testid = "clipboard-notice";
      el.setAttribute("role", "status"); // announced once by assistive tech; never focusable
      // Load-bearing + jsdom-assertable: the notice never intercepts the terminal's own clicks.
      el.style.pointerEvents = "none";
      el.textContent = CLIPBOARD_NOTICE_TEXT;
      host.appendChild(el);
      node = el;
      timerId = timers.setTimeout(() => {
        // The id is cleared FIRST so this path never calls clearTimeout on an already-fired timer.
        timerId = undefined;
        node?.remove();
        node = undefined;
      }, durationMs);
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
