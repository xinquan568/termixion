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
import { useCallback, useEffect, useState } from "react";
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
}: UseBackendOptions = {}): BackendApi {
  const [coreVersion, setCoreVersion] = useState<string | null>(null);

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
