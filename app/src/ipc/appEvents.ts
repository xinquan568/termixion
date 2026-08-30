// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: the Tauri event-bus seams App.tsx used to declare inline. L0: these touch the
// transport and nothing above it, which is why they are the only part of the old module head
// that can live here — the rest needs theme/, terminal/ or control/ and would import upward.

import { realEventBus } from "./eventBus";

/** The menu's tab-intent broadcast (main.rs emits "new"/"close"/"next"/"prev"/split verbs). */
export const TABS_ACTION_EVENT = "tabs:action";

/** Observe the menu's `tabs:action` broadcasts; returns a teardown. */
export type TabsActionObservation = (onAction: (payload: unknown) => void) => () => void;

/** Observe `pty:exited` sessionIds; returns a teardown. */
export type PtyExitedObservation = (onExit: (sessionId: number) => void) => () => void;

/** Observe `session:title-hint` broadcasts (trmx-75); returns a teardown. */
export type TitleHintObservation = (
  onHint: (sessionId: number, name: string) => void,
) => () => void;

/** trmx-159: injection seam for tests — observe a session's PTY output byte length. */
export type OutputObservation = (
  onOutput: (sessionId: number, byteLength: number) => void,
) => () => void;

/** trmx-159: injection seam for tests — observe a session's keystroke input. */
export type InputObservation = (
  onInput: (sessionId: number, data: string) => void,
) => () => void;


// Observe the menu's tabs:action broadcasts over the event bus, with the teardown-before-resolve
// pattern from TerminalView's realObserveSettings: a teardown called before the async listen
// resolves unlistens the late subscription instead of leaking it, and the `live` guard keeps a
// torn-down handler silent. In a plain browser/jsdom the listen rejects and the seam is inert.
export const realObserveTabsAction: TabsActionObservation = (onAction) => {
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

/** Payload of the backend's `session:notice` event (trmx-237): a line for one session's pane. */
export type SessionNotice = { session_id: number; text: string };
export type SessionNoticeObservation = (onNotice: (notice: SessionNotice) => void) => () => void;

export const realObserveSessionNotice: SessionNoticeObservation = (onNotice) => {
  let live = true;
  let unlisten: (() => void) | undefined;
  realEventBus
    .listen("session:notice", (payload) => {
      if (!live) return;
      const n = payload as Partial<SessionNotice> | null;
      if (!n || typeof n.session_id !== "number" || typeof n.text !== "string") return;
      onNotice({ session_id: n.session_id, text: n.text });
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — nothing emits pane notices in a plain browser.
    });
  return () => {
    live = false;
    unlisten?.();
  };
};

// trmx-144: observe the backend's `close:requested` broadcasts (the native window close / ⌘Q
// intercepted Rust-side and round-tripped to the webview for the quit confirm) — the same
// teardown-before-resolve pattern as realObserveControlRequest above.
/**
 * trmx-268: a wire ask generation. `AskTracker` starts at 0 and pre-increments, so the first ask on
 * the wire is 1 — anything else (missing, non-numeric, 0, negative, fractional, NaN, Infinity) is a
 * malformed payload and must be IGNORED, never coerced and serviced.
 */
export function isAskGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export type CloseRequestedObservation = (onRequest: (generation: number) => void) => () => void;

export const realObserveCloseRequested: CloseRequestedObservation = (onRequest) => {
  let live = true;
  let unlisten: (() => void) | undefined;
  realEventBus
    .listen("close:requested", (generation) => {
      // trmx-268: the payload is the ask generation the ack must echo. A malformed one is dropped
      // rather than coerced — servicing a bogus generation would ack a streak that does not exist.
      if (live && isAskGeneration(generation)) onRequest(generation);
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
