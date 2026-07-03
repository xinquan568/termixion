// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-5 + C-2: the backend hook. core_version handshake on mount; attachTerminal wires a terminal to
// the PTY (output→terminal, keystrokes/resize→backend). Everything injected — no Tauri runtime
// needed. trmx-74: attach is session-scoped — it awaits open_pty FIRST (the id must exist before
// any keystroke can be addressed), wires data/resize to the RETURNED sessionId, and resolves the
// SessionInfo so the tab layer can bind the session to a tab.
import { afterEach, describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useBackend } from "./useBackend";
import type { InvokeFn, PtyBytesHandler, SessionInfo } from "./backend";
import type { TerminalHandle, TerminalLike } from "../terminal/mountTerminal";

afterEach(() => {
  vi.restoreAllMocks();
});

type OpenPty = (
  onBytes: PtyBytesHandler,
  rows: number,
  cols: number,
  opts: { cwd?: string } | undefined,
  invoke: InvokeFn,
) => Promise<SessionInfo>;

const SESSION: SessionInfo = { sessionId: 42, title: "zsh" };

// A fake terminal capturing the wired handlers so the test can simulate input/output/resize.
// `size` mimics the real xterm Terminal's live `rows`/`cols` (already set by mountTerminal's initial
// fit() before attach) that TerminalLike deliberately doesn't declare; omit it for a bare fake.
function fakeHandle(size?: { rows: number; cols: number }) {
  const writes: Uint8Array[] = [];
  let dataHandler: ((d: string) => void) | undefined;
  let resizeHandler: ((s: { rows: number; cols: number }) => void) | undefined;
  const terminal: TerminalLike & { rows?: number; cols?: number } = {
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
    ...size,
  };
  const handle: TerminalHandle = {
    terminal,
    renderer: "dom",
    fit() {},
    dispose() {},
  };
  return {
    handle,
    writes,
    type: (s: string) => dataHandler?.(s),
    resize: (rows: number, cols: number) => resizeHandler?.({ rows, cols }),
    isWired: () => dataHandler !== undefined,
  };
}

describe("useBackend", () => {
  it("reports the core version and logs the connection on mount", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue("9.9.9");
    const openPty = vi.fn<OpenPty>();
    openPty.mockResolvedValue(SESSION);

    const { result } = renderHook(() => useBackend({ invoke, openPty }));

    await waitFor(() => expect(result.current.coreVersion).toBe("9.9.9"));
    expect(invoke).toHaveBeenCalledWith("core_version");
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("connected to core v9.9.9"),
    );
  });

  it("attachTerminal opens the pty (output→terminal), resolves the SessionInfo, and routes keystrokes + resizes to the RETURNED sessionId", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    const openPty = vi.fn<OpenPty>();
    openPty.mockResolvedValue(SESSION);

    const { result } = renderHook(() => useBackend({ invoke, openPty }));
    const t = fakeHandle();
    const info = await result.current.attachTerminal(t.handle);

    // The session identity is resolved to the caller (the tab layer binds it, trmx-74).
    expect(info).toEqual(SESSION);

    // open_pty is opened with a byte handler + the default 24x80 grid.
    expect(openPty).toHaveBeenCalledTimes(1);
    const [onBytes, rows, cols] = openPty.mock.calls[0];
    expect(rows).toBe(24);
    expect(cols).toBe(80);
    // PTY output is routed into the terminal.
    onBytes(new Uint8Array([104, 105]));
    expect(t.writes).toHaveLength(1);
    expect(Array.from(t.writes[0])).toEqual([104, 105]);

    // Keystrokes → pty_write (UTF-8 encoded); resizes → pty_resize — both scoped to sessionId 42,
    // the id open_pty RESOLVED (a fake invoke captures the exact args).
    t.type("a");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("pty_write", {
        sessionId: 42,
        data: [97],
      }),
    );
    t.resize(40, 120);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("pty_resize", {
        sessionId: 42,
        rows: 40,
        cols: 120,
      }),
    );
  });

  it("attachTerminal forwards the cwd opt to openPty (and passes undefined when omitted)", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    const openPty = vi.fn<OpenPty>();
    openPty.mockResolvedValue(SESSION);

    const { result } = renderHook(() => useBackend({ invoke, openPty }));
    await result.current.attachTerminal(fakeHandle().handle, {
      cwd: "/Users/me/project",
    });
    expect(openPty.mock.calls[0][3]).toEqual({ cwd: "/Users/me/project" });

    await result.current.attachTerminal(fakeHandle().handle);
    expect(openPty.mock.calls[1][3]).toBeUndefined();
  });

  // trmx-74: the sessionId must exist BEFORE any keystroke can be addressed to the backend, so
  // attach awaits open_pty first and only then subscribes onData/onResize — a keystroke racing the
  // open can never fire a pty_write without (or with a stale) session id.
  it("attachTerminal wires keystrokes only after openPty resolves the session id", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    let resolveOpen: ((info: SessionInfo) => void) | undefined;
    const openPty = vi.fn<OpenPty>(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );

    const { result } = renderHook(() => useBackend({ invoke, openPty }));
    const t = fakeHandle();
    const attach = result.current.attachTerminal(t.handle);

    // The open is still in flight: nothing is subscribed, so no write can be addressed yet.
    expect(t.isWired()).toBe(false);
    t.type("a");
    expect(invoke).not.toHaveBeenCalledWith("pty_write", expect.anything());

    resolveOpen?.({ sessionId: 7, title: "zsh" });
    await attach;
    expect(t.isWired()).toBe(true);
    t.type("b");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("pty_write", {
        sessionId: 7,
        data: [98],
      }),
    );
  });

  // trmx-67: mountTerminal's initial fit() runs BEFORE attachTerminal subscribes onResize, and xterm
  // dedups same-size fits (no resize event replays it) — so attach must read the terminal's actual
  // grid, or the child process stays at 24x80 while the screen renders e.g. 30x100.
  it("attachTerminal opens the pty with the mounted terminal's actual grid size", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    const openPty = vi.fn<OpenPty>();
    openPty.mockResolvedValue(SESSION);

    const { result } = renderHook(() => useBackend({ invoke, openPty }));
    const t = fakeHandle({ rows: 30, cols: 100 }); // grid already fit before attach
    await result.current.attachTerminal(t.handle);

    expect(openPty).toHaveBeenCalledTimes(1);
    const [, rows, cols] = openPty.mock.calls[0];
    expect(rows).toBe(30);
    expect(cols).toBe(100);
  });

  it("attachTerminal falls back to 24x80 when the terminal exposes no grid size", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    const openPty = vi.fn<OpenPty>();
    openPty.mockResolvedValue(SESSION);

    const { result } = renderHook(() => useBackend({ invoke, openPty }));
    const t = fakeHandle(); // bare fake: no rows/cols on the terminal
    await result.current.attachTerminal(t.handle);

    expect(openPty).toHaveBeenCalledTimes(1);
    const [, rows, cols] = openPty.mock.calls[0];
    expect(rows).toBe(24);
    expect(cols).toBe(80);
  });

  // trmx-74: attach failures propagate — the tab layer must know its openTab produced no session
  // (it closes the tab / marks it dead); the log keeps browser-dev diagnosable.
  it("attachTerminal logs and rethrows when openPty fails, leaving the terminal unwired", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    const openPty = vi.fn<OpenPty>();
    openPty.mockRejectedValue(new Error("spawn failed"));

    const { result } = renderHook(() => useBackend({ invoke, openPty }));
    const t = fakeHandle();
    await expect(result.current.attachTerminal(t.handle)).rejects.toThrow(
      "spawn failed",
    );
    expect(error).toHaveBeenCalledWith(
      "[termixion] open pty failed",
      expect.any(Error),
    );
    // No session → no subscriptions: a later keystroke must not reach the backend.
    expect(t.isWired()).toBe(false);
  });

  it("does not throw and stays unconnected when the handshake fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockRejectedValue(new Error("no backend (browser dev)"));
    const openPty = vi.fn<OpenPty>();
    openPty.mockResolvedValue(SESSION);

    const { result } = renderHook(() => useBackend({ invoke, openPty }));

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(result.current.coreVersion).toBeNull();
  });
});
