// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// C-3 (test-first): the smoke driver — opens the PTY, writes the sentinel sequence, waits for the
// done marker in the output, evaluates, and reports the result. Injected deps → no Tauri runtime.
// trmx-74: open_pty resolves { sessionId, title } and pty_write is session-scoped, so the driver
// must thread the resolved id into sendInput; the sentinel behavior itself is unchanged.
import { describe, it, expect, vi } from "vitest";
import { runSmoke, type SmokeDeps } from "./runSmoke";
import type { InvokeFn, PtyBytesHandler, SessionInfo } from "../ipc/backend";

const DIR = "/private/tmp/x/termixion-smoke";
const SESSION: SessionInfo = { sessionId: 11, title: "zsh" };
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
    const openPty = vi.fn(async (cb: PtyBytesHandler): Promise<SessionInfo> => {
      onBytes = cb;
      return SESSION;
    });
    const sendInput =
      vi.fn<(sessionId: number, data: string, invoke: InvokeFn) => Promise<void>>();
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

    // trmx-74: the driver threads the sessionId open_pty RESOLVED into the session-scoped write.
    expect(sendInput).toHaveBeenCalledTimes(1);
    const [sessionId, script] = sendInput.mock.calls[0];
    expect(sessionId).toBe(SESSION.sessionId);
    // The script drives pwd / cd via the $DIR env var / pwd / ls, plus a disambiguated done marker.
    expect(script).toContain("pwd");
    expect(script).toContain('cd -- "$DIR"'); // env-var expansion, not interpolated path
    expect(script).toContain("ls");
    expect(script).not.toContain("__TXSMOKEDONE__"); // the echoed input must NOT carry the contiguous marker

    expect(result.ok).toBe(true);
    expect(reportDone).toHaveBeenCalledWith(true, expect.any(String), invoke);
  });

  it("reports failure when the sentinel file is absent", async () => {
    let onBytes: PtyBytesHandler | undefined;
    const sendInput =
      vi.fn<(sessionId: number, data: string, invoke: InvokeFn) => Promise<void>>();
    sendInput.mockResolvedValue(undefined);
    const reportDone =
      vi.fn<(ok: boolean, reason: string, invoke: InvokeFn) => Promise<void>>();
    reportDone.mockResolvedValue(undefined);
    const deps: SmokeDeps = {
      invoke: (() => Promise.resolve(undefined)) as InvokeFn,
      openPty: async (cb) => {
        onBytes = cb;
        return SESSION;
      },
      sendInput,
      reportDone,
    };
    const promise = runSmoke(DIR, deps);
    onBytes!(
      new TextEncoder().encode(goodOutput.replace("SMOKE_OK", "NOPE")),
    );
    const result = await promise;
    expect(result.ok).toBe(false);
    // The id is threaded on the failure path too — the write happened before the evaluation.
    expect(sendInput).toHaveBeenCalledWith(
      SESSION.sessionId,
      expect.any(String),
      deps.invoke,
    );
    expect(deps.reportDone).toHaveBeenCalledWith(false, expect.any(String), deps.invoke);
  });
});
