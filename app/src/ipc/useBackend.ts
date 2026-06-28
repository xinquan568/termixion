// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-5 + C-2: the backend hook. On mount it does the core_version handshake (status line). It also
// returns `attachTerminal`, which the TerminalView calls once its terminal is mounted to wire the live
// PTY (ADR-0001): PTY output → terminal, keystrokes/resizes → the backend. `invoke`/`openPty` are
// injectable so the wiring is testable without the Tauri runtime; the real edge is `cargo tauri dev`.
import { useCallback, useEffect, useState } from "react";
import {
  getCoreVersion,
  openPty as realOpenPty,
  realInvoke,
  sendPtyInput,
  sendPtyResize,
  type InvokeFn,
  type PtyBytesHandler,
} from "./backend";
import type { TerminalHandle } from "../terminal/mountTerminal";

export interface UseBackendOptions {
  invoke?: InvokeFn;
  openPty?: (
    onBytes: PtyBytesHandler,
    rows: number,
    cols: number,
    invoke: InvokeFn,
  ) => Promise<void>;
}

export interface BackendApi {
  /** The backend's core version once the handshake resolves, else `null` (connecting / no backend). */
  coreVersion: string | null;
  /** Wire a mounted terminal to a live PTY session: output → terminal, keystrokes/resizes → backend. */
  attachTerminal: (handle: TerminalHandle) => void;
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
    (handle: TerminalHandle) => {
      const term = handle.terminal;
      // Keystrokes → the PTY.
      term.onData((data) => {
        sendPtyInput(data, invoke).catch((err: unknown) =>
          console.error("[termixion] pty write failed", err),
        );
      });
      // Resizes → the PTY's grid.
      term.onResize(({ rows, cols }) => {
        sendPtyResize(rows, cols, invoke).catch((err: unknown) =>
          console.error("[termixion] pty resize failed", err),
        );
      });
      // Open the session and stream output → the terminal. v0.0.1 uses the default 24x80 grid (no fit
      // addon yet); onResize keeps the PTY in sync if that changes.
      openPty((bytes) => term.write(bytes), 24, 80, invoke).catch((err: unknown) =>
        console.error("[termixion] open pty failed", err),
      );
    },
    [invoke, openPty],
  );

  return { coreVersion, attachTerminal };
}
