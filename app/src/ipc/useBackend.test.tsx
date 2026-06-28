// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-5 (test-first): the handshake hook. On mount it does the command round-trip (core_version) and
// sets up the PTY channel, with everything injected so no real Tauri runtime is needed.
import { afterEach, describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useBackend } from "./useBackend";
import type { InvokeFn, PtyBytesHandler } from "./backend";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBackend", () => {
  it("reports the core version and logs the connection on mount", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue("9.9.9");
    const openChannel =
      vi.fn<(onBytes: PtyBytesHandler, invoke: InvokeFn) => Promise<void>>();
    openChannel.mockResolvedValue(undefined);

    const { result } = renderHook(() => useBackend({ invoke, openChannel }));

    await waitFor(() => expect(result.current.coreVersion).toBe("9.9.9"));
    expect(invoke).toHaveBeenCalledWith("core_version");
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("connected to core v9.9.9"),
    );
  });

  it("sets up the PTY channel with a handler", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue("1.0.0");
    const openChannel =
      vi.fn<(onBytes: PtyBytesHandler, invoke: InvokeFn) => Promise<void>>();
    openChannel.mockResolvedValue(undefined);

    renderHook(() => useBackend({ invoke, openChannel }));

    await waitFor(() => expect(openChannel).toHaveBeenCalledTimes(1));
    expect(typeof openChannel.mock.calls[0][0]).toBe("function"); // the byte handler
  });

  it("does not throw and stays unconnected when the handshake fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const invoke = vi.fn<InvokeFn>();
    invoke.mockRejectedValue(new Error("no backend (browser dev)"));
    const openChannel =
      vi.fn<(onBytes: PtyBytesHandler, invoke: InvokeFn) => Promise<void>>();
    openChannel.mockResolvedValue(undefined);

    const { result } = renderHook(() => useBackend({ invoke, openChannel }));

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(result.current.coreVersion).toBeNull();
  });
});
