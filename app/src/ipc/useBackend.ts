// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-5: the handshake hook. On mount it performs the command round-trip (core_version) and sets up the
// PTY-bytes channel. Both the `invoke` and the channel opener are injectable so the hook is testable
// without the Tauri runtime; the defaults are the real edge used by the app.
import { useEffect, useState } from "react";
import {
  getCoreVersion,
  openPtyChannel,
  realInvoke,
  type InvokeFn,
  type PtyBytesHandler,
} from "./backend";

export interface UseBackendOptions {
  invoke?: InvokeFn;
  openChannel?: (onBytes: PtyBytesHandler, invoke: InvokeFn) => Promise<void>;
  /** Where PTY output bytes go; defaults to logging the readiness frame (B-5). C-2 feeds the terminal. */
  onPtyBytes?: PtyBytesHandler;
}

export interface BackendState {
  /** The backend's core version once the handshake resolves, else `null` (connecting / no backend). */
  coreVersion: string | null;
}

export function useBackend({
  invoke = realInvoke,
  openChannel = openPtyChannel,
  onPtyBytes,
}: UseBackendOptions = {}): BackendState {
  const [coreVersion, setCoreVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    // 1) Command round-trip — report the core version (the B-5 acceptance handshake).
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

    // 2) Set up the PTY-bytes channel. B-5's backend emits one readiness frame; C-2 streams output.
    const handler: PtyBytesHandler =
      onPtyBytes ??
      ((bytes) =>
        console.info(
          `[termixion] pty channel: ${new TextDecoder().decode(bytes)}`,
        ));
    openChannel(handler, invoke).catch((err: unknown) => {
      console.error("[termixion] pty channel setup failed", err);
    });

    return () => {
      active = false;
    };
  }, [invoke, openChannel, onPtyBytes]);

  return { coreVersion };
}
