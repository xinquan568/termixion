// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-247: the window-lifecycle IPC edge, moved out of App.tsx. All three are pure transport — one
// `realInvoke` each with a swallowed rejection — and were the last transport helpers living above
// `ipc/`. App.tsx imports them as its prop defaults.
//
// The rejections are swallowed deliberately: with no Tauri runtime (a plain browser tab, jsdom)
// there is nothing to close, quit, or prove liveness to, and the caller has no recovery to perform.

import { realInvoke } from "./backend";

/**
 * The production last-tab-close sink: close the native window. Lazy-imported and error-swallowed
 * like realSetWindowTitle (windowTitle.ts) — without a Tauri runtime (`pnpm dev`, jsdom) there is
 * no window to close and that must stay inert. No per-session cleanup here: the backend's
 * CloseRequested handler kill_all's every session (trmx-74).
 */
export function realCloseWindow(): void {
  // trmx-268: NO native close. This was the only non-test frontend path to a native close of the
  // MAIN window, and it existed purely to trigger the backend's veto-and-ask round trip. Asking the
  // backend directly means a native `CloseRequested` can now only be a genuine traffic-light gesture
  // or `quit_confirmed`'s authorized re-drive — there is no third, uncorrelatable case to reason
  // about. (`app/src/main.tsx`'s `closeThisWindow` still closes the SETTINGS window natively; the
  // gate answers `Ignore` for it.)
  realInvoke("webview_close_request").catch(() => {
    // No Tauri runtime — a plain browser tab owns its own lifecycle.
  });
}

/**
 * trmx-268: the webview's proof of life. Carries the GENERATION being answered, so an ack for a
 * streak the backend has since restarted is ignored — an acknowledged-then-hung webview still
 * reaches the fallback in two gestures.
 */
export function realCloseAcknowledged(generation: number): Promise<void> {
  return realInvoke("close_acknowledged", { generation }).then(
    () => undefined,
    () => undefined, // no Tauri runtime, or the window went away — nothing to prove liveness to
  );
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
