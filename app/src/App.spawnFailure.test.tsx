// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-237 (grill H4): a failed PTY spawn must be VISIBLE. Before this the attach rejection was logged and
// nothing else happened: the pane kept its placeholder title with no session, so output never came and
// keystrokes went nowhere, with no clue why. The realistic trigger is a new tab inheriting the active
// tab's OSC-7 cwd after that directory was deleted.
//
// The epoch guard is the subtle half. React StrictMode double-mounts, so two attaches can be in flight for
// one pane; the SUCCESS path already ignores a superseded epoch (App.tsx). Without the same guard on the
// rejection path, a stale attach's rejection could scribble an error into a pane whose later attach
// succeeded — an error message on a working shell. Both cases are pinned here.
import { describe, expect, it, vi } from "vitest";
import { formatAttachError, writePaneNotice } from "./App";
import type { TerminalHandle } from "./terminal/mountTerminal";

function decode(calls: unknown[][]): string {
  return calls.map((c) => new TextDecoder().decode(c[0] as Uint8Array)).join("");
}

describe("writePaneNotice / formatAttachError (trmx-237 H4)", () => {
  it("writes a red, self-contained line as BYTES (the terminal seam's contract)", () => {
    const write = vi.fn();
    writePaneNotice({ terminal: { write } } as unknown as TerminalHandle, "could not start a shell: nope");
    expect(write).toHaveBeenCalledTimes(1);
    const text = decode(write.mock.calls);
    // Cross-realm safe (jsdom): `instanceof` would be false for a Node-created view.
    expect(ArrayBuffer.isView(write.mock.calls[0][0])).toBe(true);
    // Its own lines, so it never mangles surrounding shell output; red, then RESET (a leaked SGR
    // would tint everything the shell printed afterwards).
    expect(text.startsWith("\r\n")).toBe(true);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text).toContain("\x1b[31m");
    expect(text).toContain("\x1b[0m");
    expect(text).toContain("[termixion] could not start a shell: nope");
  });

  it("renders an Error by message and never throws on an exotic reason", () => {
    expect(formatAttachError(new Error("cwd is not a directory: /gone"))).toBe(
      "cwd is not a directory: /gone",
    );
    expect(formatAttachError("plain string")).toBe("plain string");
    expect(formatAttachError(undefined)).toBe("unknown error");
    expect(formatAttachError({ weird: true })).toBe("unknown error");
  });
});
