// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-5 + C-2: the backend hook. On mount it does the core_version handshake (status line). It also
// returns `attachTerminal`, which the TerminalView calls once its terminal is mounted to wire the live
// PTY (ADR-0001): PTY output → terminal, keystrokes/resizes → the backend. `invoke`/`openPty` are
// injectable so the wiring is testable without the Tauri runtime; the real edge is `cargo tauri dev`.
//
// trmx-74: attach is session-scoped. It awaits open_pty FIRST — the sessionId must exist before any
// keystroke can be addressed to the backend — THEN subscribes onData/onResize against the returned
// id, and resolves the SessionInfo so the tab layer can bind session→tab (or dispose the orphan when
// the tab died while the open was in flight). An optional `cwd` opt seeds the shell's directory
// (new-tab-inherits-cwd, fed from the OSC 7 store).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCoreVersion,
  openPty as realOpenPty,
  realInvoke,
  sendPtyAck,
  sendPtyInput,
  sendPtyResize,
  type InvokeFn,
  type PtyBytesHandler,
  type SessionInfo,
} from "./backend";
import type { TerminalHandle } from "../terminal/mountTerminal";

export interface UseBackendOptions {
  invoke?: InvokeFn;
  openPty?: (
    onBytes: PtyBytesHandler,
    rows: number,
    cols: number,
    opts: { cwd?: string } | undefined,
    invoke: InvokeFn,
  ) => Promise<SessionInfo>;
  /**
   * trmx-159: observe a session's PTY OUTPUT — the byte LENGTH of each parsed output chunk (never the
   * bytes themselves; terminal data stays off the observation path, ADR-0001). Fired on xterm's
   * parse-completion callback, scoped to the resolved sessionId. Drives the activity light's
   * output-recency / echo-suppression signal. Optional — absent is inert.
   */
  onOutput?: (sessionId: number, byteLength: number) => void;
  /**
   * trmx-159: observe a session's keystroke INPUT (the xterm `onData` string) so the activity light
   * can detect a submit (a `\r`/`\n`). Scoped to the resolved sessionId, fired alongside the pty_write
   * that sends the keystroke to the backend. Optional — absent is inert.
   */
  onInput?: (sessionId: number, data: string) => void;
}

export interface BackendApi {
  /** The backend's core version once the handshake resolves, else `null` (connecting / no backend). */
  coreVersion: string | null;
  /**
   * Wire a mounted terminal to a live PTY session: output → terminal, keystrokes/resizes → backend
   * (scoped to the opened sessionId, trmx-74). Resolves the session's identity; on open failure it
   * logs and rethrows — callers decide (the tab layer marks the tab dead; a fire-and-forget caller
   * may ignore the promise).
   */
  attachTerminal: (
    handle: TerminalHandle,
    opts?: { cwd?: string },
  ) => Promise<SessionInfo>;
}

export function useBackend({
  invoke = realInvoke,
  openPty = realOpenPty,
  onOutput,
  onInput,
}: UseBackendOptions = {}): BackendApi {
  const [coreVersion, setCoreVersion] = useState<string | null>(null);
  // trmx-159: keep the I/O observers behind a ref so attachTerminal stays a STABLE identity (a new
  // closure would remount the terminal via the effect deps). App re-points the ref each render; the
  // per-attach wiring always reads the latest observer.
  const observersRef = useRef({ onOutput, onInput });
  observersRef.current = { onOutput, onInput };

  useEffect(() => {
    let active = true;
    getCoreVersion(invoke)
      .then((version) => {
        if (!active) return;
        setCoreVersion(version);
        console.info(`[termixion] connected to core v${version}`);
      })
      .catch((err: unknown) => {
        // Browser dev (`pnpm dev`) has no backend, so this rejects — log, don't crash.
        console.error("[termixion] core handshake failed", err);
      });
    return () => {
      active = false;
    };
  }, [invoke]);

  const attachTerminal = useCallback(
    async (
      handle: TerminalHandle,
      opts?: { cwd?: string },
    ): Promise<SessionInfo> => {
      const term = handle.terminal;
      // Open the session at the mounted terminal's ACTUAL grid size (trmx-67). mountTerminal's
      // initial fit() already ran before this onResize subscription existed, and xterm dedups
      // same-size fits (no resize event replays it) — so a hardcoded 24x80 here would strand the
      // child process at 24x80 while the screen renders e.g. 30x100. TerminalLike deliberately stays
      // narrow, so read the real xterm Terminal's rows/cols via a localized adapter cast; the 24x80
      // fallback covers bare fakes in tests.
      const t = handle.terminal as unknown as { rows?: number; cols?: number };
      let session: SessionInfo;
      // trmx-78 round 2b: ack every chunk on xterm PARSE COMPLETION so the backend's
      // flow-control window tracks the real parse rate. The session id resolves only after the
      // open; the handful of pre-resolution chunks (shell banner) ride the ample initial window.
      let ackSessionId = 0;
      try {
        session = await openPty(
          (bytes) =>
            term.write(bytes, () => {
              if (ackSessionId > 0) {
                // trmx-159: observe output (LENGTH only) at parse completion, scoped to the session.
                observersRef.current.onOutput?.(ackSessionId, bytes.length);
                void sendPtyAck(ackSessionId, bytes.length, invoke).catch(() => {});
              }
            }),
          t.rows ?? 24,
          t.cols ?? 80,
          opts,
          invoke,
        );
      } catch (err: unknown) {
        console.error("[termixion] open pty failed", err);
        throw err;
      }
      ackSessionId = session.sessionId;
      // Only NOW is there a sessionId to address — subscribe after the open resolves (trmx-74), so
      // a keystroke racing the open can never fire a session-less (or wrong-session) pty_write.
      // Keystrokes → the PTY.
      term.onData((data) => {
        // trmx-159: observe input (for the \r/\n submit signal) alongside routing the keystroke.
        observersRef.current.onInput?.(session.sessionId, data);
        sendPtyInput(session.sessionId, data, invoke).catch((err: unknown) =>
          console.error("[termixion] pty write failed", err),
        );
      });
      // Resizes → the PTY's grid.
      term.onResize(({ rows, cols }) => {
        sendPtyResize(session.sessionId, rows, cols, invoke).catch((err: unknown) =>
          console.error("[termixion] pty resize failed", err),
        );
      });
      return session;
    },
    [invoke, openPty],
  );

  return { coreVersion, attachTerminal };
}
