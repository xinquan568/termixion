// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: the App seams that depend on terminal/ (L3) — a mounted TerminalHandle, the settings
// observation shape, and the drag frame schedule. These cannot live in ipc/ (L0): ipc may not
// import terminal.

import type { SessionInfo } from "../ipc/backend";
import { realEventBus } from "../ipc/eventBus";
import type { TerminalHandle } from "./mountTerminal";
import { type FrameSchedule } from "./resizeCoalescer";
import { SETTINGS_CHANGED_EVENT } from "../store/settingsStore";
import { type SettingsObservation } from "./TerminalView";

// trmx-85: the drag rAF schedule (one setPaneRatio per frame, the trmx-67 coalescer idiom). A
// module-level const — NOT an inline arrow — and injectable via AppProps for deterministic tests.
export const realFrameSchedule: FrameSchedule = (cb) => {
  if (typeof requestAnimationFrame === "undefined") {
    const t = setTimeout(cb, 16);
    return () => clearTimeout(t);
  }
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
};

/** Wire a mounted terminal to a live PTY session; resolves the session's identity (useBackend). */
export type AttachFn = (
  handle: TerminalHandle,
  opts?: { cwd?: string },
) => Promise<SessionInfo>;

// trmx-81: observe settings:changed for the tab-bar position — the same teardown-before-resolve
// pattern as realObserveTabsAction above (TerminalView's realObserveSettings). A module-level
// const, NOT an inline arrow: it is an effect dep, and a fresh identity every render would
// re-subscribe on every App re-render.
export const realObserveAppSettings: SettingsObservation = (onChange) => {
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

// trmx-237 (grill H4): the pane's own error channel. A backend notice (a cwd that could not be honored)
// and a failed attach both end up as one dim-red line in the terminal the user is already looking at —
// the only surface that is guaranteed to be visible for the thing that just went wrong.
export function writePaneNotice(handle: TerminalHandle, text: string): void {
  // The terminal seam takes BYTES (the PTY contract), so encode rather than passing a string.
  // \x1b[31m … \x1b[0m: red, then reset. On its own lines so it never mangles shell output.
  const line = `\r\n\x1b[31m[termixion] ${text}\x1b[0m\r\n`;
  handle.terminal.write(new TextEncoder().encode(line));
}

/** A rejection reason rendered for a terminal line: an Error's message, else a compact string. */
export function formatAttachError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "unknown error";
}
