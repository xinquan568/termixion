// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-5 + C-2: the backend hook. core_version handshake on mount; attachTerminal wires a terminal to the
// PTY (output→terminal, keystrokes/resize→backend). Everything injected — no Tauri runtime needed.
import { afterEach, describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useBackend } from "./useBackend";
import type { InvokeFn, PtyBytesHandler } from "./backend";
import type { TerminalHandle, TerminalLike } from "../terminal/mountTerminal";

afterEach(() => {
  vi.restoreAllMocks();
});

type OpenPty = (
  onBytes: PtyBytesHandler,
  rows: number,
  cols: number,
  invoke: InvokeFn,
) => Promise<void>;

// A fake terminal capturing the wired handlers so the test can simulate input/output/resize.
function fakeHandle() {
  const writes: Uint8Array[] = [];
  let dataHandler: ((d: string) => void) | undefined;
  let resizeHandler: ((s: { rows: number; cols: number }) => void) | undefined;
  const terminal: TerminalLike = {
    open() {},
    loadAddon() {},
    write(d) {
      writes.push(d);
    },
    onData(h) {
      dataHandler = h;
    },
    onResize(h) {
      resizeHandler = h;
    },
    dispose() {},
  };
  const handle: TerminalHandle = { terminal, renderer: "dom", dispose() {} };
  return {
    handle,
    writes,
    type: (s: string) => dataHandler?.(s),
    resize: (rows: number, cols: number) => resizeHandler?.({ rows, cols }),
  };
}

describe("useBackend", () => {
  it("reports the core version and logs the connection on mount", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue("9.9.9");
    const openPty = vi.fn<OpenPty>();
    openPty.mockResolvedValue(undefined);

    const { result } = renderHook(() => useBackend({ invoke, openPty }));

    await waitFor(() => expect(result.current.coreVersion).toBe("9.9.9"));
    expect(invoke).toHaveBeenCalledWith("core_version");
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("connected to core v9.9.9"),
    );
  });

  it("attachTerminal opens the pty (output→terminal) and routes keystrokes + resizes back", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    const openPty = vi.fn<OpenPty>();
    openPty.mockResolvedValue(undefined);

    const { result } = renderHook(() => useBackend({ invoke, openPty }));
    const t = fakeHandle();
    result.current.attachTerminal(t.handle);

    // open_pty is opened with a byte handler + the default 24x80 grid.
    expect(openPty).toHaveBeenCalledTimes(1);
    const [onBytes, rows, cols] = openPty.mock.calls[0];
    expect(rows).toBe(24);
    expect(cols).toBe(80);
    // PTY output is routed into the terminal.
    onBytes(new Uint8Array([104, 105]));
    expect(t.writes).toHaveLength(1);
    expect(Array.from(t.writes[0])).toEqual([104, 105]);

    // Keystrokes → pty_write (UTF-8 encoded); resizes → pty_resize.
    t.type("a");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("pty_write", { data: [97] }),
    );
    t.resize(40, 120);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("pty_resize", { rows: 40, cols: 120 }),
    );
  });

  it("does not throw and stays unconnected when the handshake fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockRejectedValue(new Error("no backend (browser dev)"));
    const openPty = vi.fn<OpenPty>();
    openPty.mockResolvedValue(undefined);

    const { result } = renderHook(() => useBackend({ invoke, openPty }));

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(result.current.coreVersion).toBeNull();
  });
});
