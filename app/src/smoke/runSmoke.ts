// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// C-3: the end-to-end smoke driver. In `--smoke` mode the webview opens a session over the PRODUCTION
// Tauri channel (C-2), writes the deterministic sentinel sequence, accumulates the output, asserts via
// evaluateSmoke, and reports back so the backend exits 0/1. Deps are injected so the logic is unit-
// tested headless; the real run needs the packaged app (D-3).
import {
  openPty,
  realInvoke,
  sendPtyInput,
  type InvokeFn,
  type PtyBytesHandler,
} from "../ipc/backend";
import { evaluateSmoke, type SmokeResult } from "./evaluateSmoke";

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
  openPty: (
    onBytes: PtyBytesHandler,
    rows: number,
    cols: number,
    invoke: InvokeFn,
  ) => Promise<void>;
  sendInput: (data: string, invoke: InvokeFn) => Promise<void>;
  reportDone: (ok: boolean, reason: string, invoke: InvokeFn) => Promise<void>;
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

  await deps.openPty(
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
  await deps.sendInput(SMOKE_SCRIPT, deps.invoke);
  await reachedMarker; // the backend watchdog (30s) fails the smoke if this never fires

  const result = evaluateSmoke(output, dir);
  await deps.reportDone(result.ok, result.reason, deps.invoke);
  return result;
}

/** The real, Tauri-backed deps used by the app entry. */
export const realSmokeDeps: SmokeDeps = {
  invoke: realInvoke,
  openPty,
  sendInput: sendPtyInput,
  reportDone: (ok, reason, invoke) =>
    invoke("smoke_done", { success: ok, reason }).then(() => {}),
};
