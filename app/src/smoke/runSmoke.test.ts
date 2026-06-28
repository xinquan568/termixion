// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// C-3 (test-first): the smoke driver — opens the PTY, writes the sentinel sequence, waits for the
// done marker in the output, evaluates, and reports the result. Injected deps → no Tauri runtime.
import { describe, it, expect, vi } from "vitest";
import { runSmoke, type SmokeDeps } from "./runSmoke";
import type { InvokeFn, PtyBytesHandler } from "../ipc/backend";

const DIR = "/private/tmp/x/termixion-smoke";
const goodOutput = [
  "host% pwd",
  "/Users/me",
  `host% cd "${DIR}"`,
  "host% pwd",
  DIR,
  "host% ls",
  "SMOKE_OK",
  'host% echo __TXSMOKE""DONE__',
  "__TXSMOKEDONE__", // the marker as OUTPUT (contiguous)
].join("\r\n");

describe("runSmoke", () => {
  it("drives the sentinel sequence, evaluates the output, and reports success", async () => {
    let onBytes: PtyBytesHandler | undefined;
    const openPty = vi.fn(async (cb: PtyBytesHandler) => {
      onBytes = cb;
    });
    const sendInput =
      vi.fn<(data: string, invoke: InvokeFn) => Promise<void>>();
    sendInput.mockResolvedValue(undefined);
    const reportDone =
      vi.fn<(ok: boolean, reason: string, invoke: InvokeFn) => Promise<void>>();
    reportDone.mockResolvedValue(undefined);
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    const deps: SmokeDeps = { invoke, openPty, sendInput, reportDone };

    const promise = runSmoke(DIR, deps);
    // openPty captures onBytes synchronously; feed the shell output incl the done marker.
    expect(onBytes).toBeDefined();
    onBytes!(new TextEncoder().encode(goodOutput));
    const result = await promise;

    // The script drives pwd / cd via the $DIR env var / pwd / ls, plus a disambiguated done marker.
    expect(sendInput).toHaveBeenCalledTimes(1);
    const script = sendInput.mock.calls[0][0];
    expect(script).toContain("pwd");
    expect(script).toContain('cd -- "$DIR"'); // env-var expansion, not interpolated path
    expect(script).toContain("ls");
    expect(script).not.toContain("__TXSMOKEDONE__"); // the echoed input must NOT carry the contiguous marker

    expect(result.ok).toBe(true);
    expect(reportDone).toHaveBeenCalledWith(true, expect.any(String), invoke);
  });

  it("reports failure when the sentinel file is absent", async () => {
    let onBytes: PtyBytesHandler | undefined;
    const reportDone =
      vi.fn<(ok: boolean, reason: string, invoke: InvokeFn) => Promise<void>>();
    reportDone.mockResolvedValue(undefined);
    const deps: SmokeDeps = {
      invoke: (() => Promise.resolve(undefined)) as InvokeFn,
      openPty: async (cb) => {
        onBytes = cb;
      },
      sendInput: async () => {},
      reportDone,
    };
    const promise = runSmoke(DIR, deps);
    onBytes!(
      new TextEncoder().encode(goodOutput.replace("SMOKE_OK", "NOPE")),
    );
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(deps.reportDone).toHaveBeenCalledWith(false, expect.any(String), deps.invoke);
  });
});
