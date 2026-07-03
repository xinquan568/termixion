// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64: OSC 0/2 window-title reporting. Shells and TUIs retitle the terminal with
// `ESC ] 0/2 ; title BEL`; xterm.js parses those and fires `onTitleChange` with the new title.
// This module is the thin bridge from that event to a title sink: `attachWindowTitle` is pure
// wiring over a narrow injected terminal slice (headless-testable — cf. `scrollbar.ts`'s
// `ScrollbarTerminalLike`), and `realSetWindowTitle` is the production sink that forwards to the
// native Tauri window (`core:window:allow-set-title`, granted in capabilities/default.json — the
// read-only `allow-title` is all `core:default` carries). The orchestrator wires the two together.

/** A minimal disposable, matching xterm's `IDisposable`. */
export interface TitleDisposable {
  dispose(): void;
}

/** The slice of an xterm `Terminal` the title bridge needs — injected so the wiring is testable headless. */
export interface TitleTerminalLike {
  /** Fires on every OSC 0/2 title change; the event value is the new title. */
  onTitleChange(handler: (title: string) => void): TitleDisposable;
}

/**
 * Forward every title the terminal reports to `setTitle`. Returns a teardown that disposes the
 * xterm subscription, after which nothing is forwarded.
 */
export function attachWindowTitle(
  terminal: TitleTerminalLike,
  setTitle: (title: string) => void,
): () => void {
  const sub = terminal.onTitleChange((title) => setTitle(title));
  return () => sub.dispose();
}

/**
 * The production sink: retitle the native Tauri window. The Tauri API is lazy-imported and every
 * rejection is swallowed — without a Tauri runtime (`pnpm dev` in a plain browser, jsdom tests)
 * `getCurrentWindow()` throws for want of `__TAURI_INTERNALS__`, and that must stay inert (cf.
 * `realObserveSettings` in TerminalView.tsx).
 */
export function realSetWindowTitle(title: string): void {
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
    .catch(() => {
      // No Tauri runtime — there is no native window to retitle; the in-app terminal is unaffected.
    });
}
