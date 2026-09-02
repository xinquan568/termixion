// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// C-3: the end-to-end smoke driver. In `--smoke` mode the webview opens a session over the PRODUCTION
// Tauri channel (C-2), writes the deterministic sentinel sequence, accumulates the output, asserts via
// evaluateSmoke, and reports back so the backend exits 0/1. Deps are injected so the logic is unit-
// tested headless; the real run needs the packaged app (D-3). trmx-74: open_pty resolves
// { sessionId, title } and pty_write is session-scoped, so the driver threads the resolved id into
// sendInput; the sentinel sequence and reporting are unchanged.
import {
  openPty,
  realInvoke,
  sendPtyInput,
  type InvokeFn,
  type PtyBytesHandler,
  type SessionInfo,
} from "../ipc/backend";
import { evaluateSmoke, type SmokeResult } from "./evaluateSmoke";
import {
  describeCspProbe,
  realCspProbeDeps,
  runCspProbe,
  type CspProbeRecord,
} from "./cspProbe";

const DONE_MARKER = "__TXSMOKEDONE__";

// The sentinel sequence (P0-4): pwd / cd "$DIR" / pwd / ls, then a done marker — as ONE `;`-separated
// line terminated by CR (a single Enter). Sending one line avoids a multi-line blob being swallowed by
// the shell's line editor / bracketed-paste. It uses the shell's inherited `$DIR` env (the same dir the
// app got) rather than interpolating the path, so shell metacharacters in the path can't change/inject
// the command; `cd --` guards a leading-dash path. The marker command is `echo __TXSMOKE""DONE__`: the
// shell concatenates `""` away so its OUTPUT is the contiguous `__TXSMOKEDONE__` while the echoed text
// keeps the `""` — so waiting for the contiguous marker matches completion (output), not the echo.
const SMOKE_SCRIPT = `pwd; cd -- "$DIR"; pwd; ls; echo __TXSMOKE""DONE__\r`;

export interface SmokeDeps {
  invoke: InvokeFn;
  /** Opens the smoke's PTY session; resolves its identity (trmx-74 session-scoped contract). */
  openPty: (
    onBytes: PtyBytesHandler,
    rows: number,
    cols: number,
    invoke: InvokeFn,
  ) => Promise<SessionInfo>;
  /** Session-scoped write: the driver threads the sessionId openPty resolved (trmx-74). */
  sendInput: (sessionId: number, data: string, invoke: InvokeFn) => Promise<void>;
  reportDone: (ok: boolean, reason: string, invoke: InvokeFn) => Promise<void>;
  /**
   * trmx-252 (M3): the CSP gate. This is the ONLY path that runs the real webview under the real
   * policy — Playwright drives the raw Vite server and never receives a Tauri CSP — so the smoke
   * carries it. A green terminal sequence must not mask a policy that breaks the app.
   */
  runCspProbe: () => Promise<CspProbeRecord>;
}

/** Drive the smoke sequence and report the result. Resolves once reported (the backend then exits). */
export async function runSmoke(
  dir: string,
  deps: SmokeDeps,
): Promise<SmokeResult> {
  let output = "";
  const decoder = new TextDecoder();
  let signalDone: (() => void) | null = null;
  const reachedMarker = new Promise<void>((resolve) => {
    signalDone = resolve;
  });

  const { sessionId } = await deps.openPty(
    (bytes) => {
      output += decoder.decode(bytes);
      if (output.includes(DONE_MARKER) && signalDone) {
        signalDone();
        signalDone = null;
      }
    },
    24,
    80,
    deps.invoke,
  );
  await deps.sendInput(sessionId, SMOKE_SCRIPT, deps.invoke);
  await reachedMarker; // the backend watchdog (SMOKE_WATCHDOG_SECS = 90s) fails the smoke if this never fires

  const pty = evaluateSmoke(output, dir);
  // trmx-252: the CSP verdict is ANDed with the PTY verdict, and its record always rides the reason
  // — a passing run's record is what tells a reader which renderer the runner used and that the
  // collector was live (the canary), neither of which is inferable from "ok".
  const csp = await deps.runCspProbe();
  const result: SmokeResult = {
    ok: pty.ok && csp.ok,
    reason: `${pty.reason} | ${describeCspProbe(csp)}`,
  };
  await deps.reportDone(result.ok, result.reason, deps.invoke);
  return result;
}

/** The real, Tauri-backed deps used by the app entry. */
export const realSmokeDeps: SmokeDeps = {
  invoke: realInvoke,
  // The smoke session runs in the backend's default cwd — no `cwd` opt (trmx-74 signature).
  openPty: (onBytes, rows, cols, invoke) =>
    openPty(onBytes, rows, cols, undefined, invoke),
  sendInput: sendPtyInput,
  reportDone: (ok, reason, invoke) =>
    invoke("smoke_done", { success: ok, reason }).then(() => {}),
  runCspProbe: () => runCspProbe(realCspProbeDeps()),
};
