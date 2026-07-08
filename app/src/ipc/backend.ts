// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-5: the frontend↔backend IPC bridge. Pure seams (getCoreVersion / decodePtyFrame / wirePtyChannel)
// are unit-tested with fakes; the real `invoke`/`Channel` edge (realInvoke / openPtyChannel) needs the
// Tauri runtime and is exercised by the real app (`cargo tauri dev`) and the packaged smoke (C-3/D-3).
// C-2 streams live PTY output through this same channel.
//
// trmx-74: every PTY command is SESSION-SCOPED so multiple tabs can each drive their own shell over
// this one bridge. `open_pty` resolves the session's identity ({ sessionId, title } — serde camelCase
// from Rust); `pty_write` / `pty_resize` / the new `close_pty` carry that sessionId; and the backend
// announces a child's exit as a `pty:exited` broadcast over the Tauri event bus (`onPtyExited`).
// Tauri v2 converts Rust snake_case command params to camelCase JS keys by default, so the JS side
// passes `sessionId` for the Rust param `session_id` — same convention as the existing
// `{ channel, rows, cols }` / `{ data }` args.
import { invoke as tauriInvoke, Channel } from "@tauri-apps/api/core";
import { realEventBus, type EventBus } from "./eventBus";
import { parseActivityPayload, type ActivityMeta } from "../panes/activityLine";

/** The `invoke` signature this module depends on — injectable so callers can fake the backend. */
export type InvokeFn = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** Receives decoded PTY output bytes. */
export type PtyBytesHandler = (bytes: Uint8Array) => void;

/** The slice of a Tauri `Channel` this module wires — just the message sink. */
export interface MessageChannel<T> {
  onmessage: (message: T) => void;
}

/** One live PTY session's identity, as `open_pty` resolves it (trmx-74). */
export interface SessionInfo {
  sessionId: number;
  title: string;
}

/** Invoke the placeholder backend command and return the core version (the B-5 handshake). */
export function getCoreVersion(invoke: InvokeFn): Promise<string> {
  // The one place we assert the command's contract: `core_version` returns a string (main.rs).
  return invoke("core_version") as Promise<string>;
}

/** Decode one PTY channel frame (the byte array Rust sends) into bytes. */
export function decodePtyFrame(frame: number[]): Uint8Array {
  return Uint8Array.from(frame);
}

/** Route a PTY channel's messages into `onBytes`, decoding each frame. */
export function wirePtyChannel(
  channel: MessageChannel<number[]>,
  onBytes: PtyBytesHandler,
): void {
  channel.onmessage = (frame) => onBytes(decodePtyFrame(frame));
}

/** Encode xterm keystroke input (a string from `onData`) to the byte array `pty_write` expects. */
export function encodePtyInput(data: string): number[] {
  return Array.from(new TextEncoder().encode(data));
}

/** The real Tauri `invoke`. In a plain browser (`pnpm dev`) there is no backend, so it rejects. */
export const realInvoke: InvokeFn = tauriInvoke as InvokeFn;

// The backend contract for a session id: Rust allocates positive u64s starting at 1, so anything
// non-integral, non-positive, or beyond JS's safe-integer range is junk (a fractional or unsafe id
// could alias another session once threaded back into pty_write). One guard, used by every ingress
// point (open_pty's response and the pty:exited payload).
function isSessionId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// The one place open_pty's response contract is asserted: an object with a positive safe-integer
// sessionId and a string title. Junk from a mismatched backend must fail HERE, loudly — not
// surface later as bogus session ids silently threaded into pty_write calls.
function isSessionInfo(value: unknown): value is SessionInfo {
  if (typeof value !== "object" || value === null) return false;
  const { sessionId, title } = value as { sessionId?: unknown; title?: unknown };
  return isSessionId(sessionId) && typeof title === "string";
}

/**
 * Open a live PTY session against the backend (real edge, ADR-0001). Constructs a Tauri `Channel`,
 * wires its frames to `onBytes` (PTY output → the terminal), and asks the backend to spawn the shell
 * at `rows`x`cols` — in `opts.cwd` when given (trmx-74 new-tab-inherits-cwd), else the backend's
 * default. The `cwd` key is attached only when provided so Rust's `Option<String>` stays `None`
 * otherwise. Resolves the session's identity; rejects with a typed Error on a junk response.
 */
export async function openPty(
  onBytes: PtyBytesHandler,
  rows: number,
  cols: number,
  opts?: { cwd?: string },
  invoke: InvokeFn = realInvoke,
): Promise<SessionInfo> {
  const channel = new Channel<number[]>();
  wirePtyChannel(channel, onBytes);
  const args: Record<string, unknown> = { channel, rows, cols };
  if (opts?.cwd !== undefined) args.cwd = opts.cwd;
  const response = await invoke("open_pty", args);
  if (!isSessionInfo(response)) {
    throw new Error(
      `[termixion] open_pty returned an invalid session shape: ${JSON.stringify(response)}`,
    );
  }
  // Copy the asserted fields so callers hold exactly the contract, not the raw response object.
  return { sessionId: response.sessionId, title: response.title };
}

/** Send keystrokes (an xterm `onData` string) to one session's PTY (trmx-74). */
export function sendPtyInput(
  sessionId: number,
  data: string,
  invoke: InvokeFn = realInvoke,
): Promise<void> {
  return invoke("pty_write", { sessionId, data: encodePtyInput(data) }).then(() => {});
}

/** Ack parsed PTY bytes back to the backend's flow-control window (trmx-78 round 2b): called on
 *  xterm's parse-completion callback so ingestion stays bounded by the real parse rate. */
export function sendPtyAck(
  sessionId: number,
  bytes: number,
  invoke: InvokeFn = realInvoke,
): Promise<void> {
  return invoke("pty_ack", { sessionId, bytes }).then(() => {});
}

/** Tell the backend one session's PTY character grid resized (from xterm `onResize`, trmx-74). */
export function sendPtyResize(
  sessionId: number,
  rows: number,
  cols: number,
  invoke: InvokeFn = realInvoke,
): Promise<void> {
  return invoke("pty_resize", { sessionId, rows, cols }).then(() => {});
}

/** Close one session's PTY (kill the child, drop the session — a tab close, trmx-74). */
export function closePty(
  sessionId: number,
  invoke: InvokeFn = realInvoke,
): Promise<void> {
  return invoke("close_pty", { sessionId }).then(() => {});
}

/** The backend broadcast fired when a session's child process exits (trmx-74). */
export const PTY_EXITED_EVENT = "pty:exited";

/**
 * Subscribe to `pty:exited` and dispatch each exited sessionId to `handler` (trmx-74 — the tab
 * layer closes the exited session's tab). Payloads are guarded the way cursorSettings guards
 * `settings:changed`: events are untrusted input, junk must be inert. Returns a teardown that is
 * safe to call BEFORE the async `listen` resolves (the realObserveSettings pattern in
 * TerminalView.tsx): a late-resolving subscription is unlistened immediately instead of leaking,
 * and the `live` guard keeps a torn-down handler silent even if the bus still fires. Without a
 * Tauri runtime (plain browser/jsdom) the listen rejects and exits simply never arrive.
 */
export function onPtyExited(
  handler: (sessionId: number) => void,
  bus: EventBus = realEventBus,
): () => void {
  let live = true;
  let unlisten: (() => void) | undefined;
  bus
    .listen(PTY_EXITED_EVENT, (payload) => {
      if (!live) return;
      if (typeof payload !== "object" || payload === null) return;
      const { sessionId } = payload as { sessionId?: unknown };
      if (!isSessionId(sessionId)) return;
      handler(sessionId);
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — there is no backend to announce exits; the subscription is inert.
    });
  return () => {
    live = false;
    unlisten?.();
  };
}

/** The backend broadcast carrying a session's foreground-process title hint (trmx-75). */
export const TITLE_HINT_EVENT = "session:title-hint";

/**
 * Subscribe to `session:title-hint` and dispatch each `{ sessionId, name }` to `handler`
 * (trmx-75 — the 1 Hz foreground poller's change-only hints; the tab layer routes each into that
 * session's tab as the PROCESS title source, which never outranks manual/OSC). Same discipline as
 * `onPtyExited`: the payload is untrusted input, guarded here (`isSessionId` for the id, a string
 * for the name — junk is inert; sanitization is the reducer's job, so the name passes through
 * RAW), and the returned teardown is safe to call BEFORE the async `listen` resolves (a
 * late-resolving subscription is unlistened instead of leaked; the `live` guard keeps a torn-down
 * handler silent even if the bus still fires). Without a Tauri runtime the listen rejects and
 * hints simply never arrive.
 */
export function onTitleHint(
  handler: (sessionId: number, name: string) => void,
  bus: EventBus = realEventBus,
): () => void {
  let live = true;
  let unlisten: (() => void) | undefined;
  bus
    .listen(TITLE_HINT_EVENT, (payload) => {
      if (!live) return;
      if (typeof payload !== "object" || payload === null) return;
      const { sessionId, name } = payload as { sessionId?: unknown; name?: unknown };
      if (!isSessionId(sessionId)) return;
      if (typeof name !== "string") return;
      handler(sessionId, name);
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — there is no poller to hint; the subscription is inert.
    });
  return () => {
    live = false;
    unlisten?.();
  };
}

/**
 * Mirror one tab's EFFECTIVE title into its core session (trmx-75). App is the SOLE core-title
 * writer — the poller only ever hints — so `Session::title` always equals what the tab renders
 * (manual > osc > process > fallback, tabTitle.ts), never a raw hint.
 */
export function setSessionTitle(
  sessionId: number,
  title: string,
  invoke: InvokeFn = realInvoke,
): Promise<void> {
  return invoke("set_session_title", { sessionId, title }).then(() => {});
}

/** The backend broadcast carrying a session's foreground busy<->idle transitions (trmx-91). */
export const SESSION_ACTIVITY_EVENT = "session:activity";

/**
 * Subscribe to `session:activity` and dispatch each `{ sessionId, busy }` to `handler` (trmx-91 —
 * the backend's change-only, 250ms busy detector; App routes each transition into the owning pane
 * and drives the activity-line debounce). Same discipline as `onTitleHint`/`onPtyExited`: the payload
 * is untrusted input, guarded HERE by the pure `parseActivityPayload` (an integer sessionId + a
 * boolean busy — junk is inert), and the returned teardown is safe to call BEFORE the async `listen`
 * resolves (a late-resolving subscription is unlistened instead of leaked; the `live` guard keeps a
 * torn-down handler silent even if the bus still fires). Without a Tauri runtime (plain browser/
 * jsdom) the listen rejects and activity transitions simply never arrive.
 */
export function onSessionActivity(
  handler: (sessionId: number, busy: boolean, meta?: ActivityMeta) => void,
  bus: EventBus = realEventBus,
): () => void {
  let live = true;
  let unlisten: (() => void) | undefined;
  bus
    .listen(SESSION_ACTIVITY_EVENT, (payload) => {
      if (!live) return;
      const parsed = parseActivityPayload(payload);
      if (parsed === null) return;
      // trmx-159: forward the optional rise classification metadata. Call with exactly two args when
      // there is none (no phantom trailing `undefined`), so the trmx-91 handler contract is unchanged.
      if (parsed.meta) handler(parsed.sessionId, parsed.busy, parsed.meta);
      else handler(parsed.sessionId, parsed.busy);
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — there is no backend to announce activity; the subscription is inert.
    });
  return () => {
    live = false;
    unlisten?.();
  };
}
