// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-5 (test-first): the IPC bridge seams. The real `invoke`/`Channel` edge (openPtyChannel) needs the
// Tauri runtime and is exercised in the real app; here we test the pure pieces with fakes.
import { describe, it, expect, vi } from "vitest";
import {
  decodePtyFrame,
  getCoreVersion,
  wirePtyChannel,
  type InvokeFn,
  type MessageChannel,
} from "./backend";

describe("getCoreVersion", () => {
  it("invokes the core_version command and returns its result", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue("1.2.3");
    await expect(getCoreVersion(invoke)).resolves.toBe("1.2.3");
    expect(invoke).toHaveBeenCalledWith("core_version");
  });

  it("propagates a rejected invoke", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockRejectedValue(new Error("no backend"));
    await expect(getCoreVersion(invoke)).rejects.toThrow("no backend");
  });
});

describe("decodePtyFrame", () => {
  it("turns a byte-number array into a Uint8Array", () => {
    expect(decodePtyFrame([104, 105])).toEqual(new Uint8Array([104, 105]));
    expect(new TextDecoder().decode(decodePtyFrame([104, 105]))).toBe("hi");
  });

  it("handles an empty frame", () => {
    expect(decodePtyFrame([])).toEqual(new Uint8Array([]));
  });
});

describe("wirePtyChannel", () => {
  it("routes decoded frames from the channel to the byte handler", () => {
    let onmessage: ((frame: number[]) => void) | undefined;
    const channel: MessageChannel<number[]> = {
      set onmessage(fn) {
        onmessage = fn;
      },
      get onmessage() {
        return onmessage as (frame: number[]) => void;
      },
    };
    const received: Uint8Array[] = [];

    wirePtyChannel(channel, (bytes) => received.push(bytes));

    // The backend's readiness frame ("channel-ready") must reach the handler as decoded bytes.
    const frame = Array.from(new TextEncoder().encode("channel-ready"));
    onmessage?.(frame);

    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0])).toBe("channel-ready");
  });
});
