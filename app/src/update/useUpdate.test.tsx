// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the useUpdate hook spec — drives a fake UpdateClient + fake auto-check source through the
// flow. trmx-51: mount-time scheduling moved to useUpdateAuthority; this hook never checks by itself.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeFakeUpdateClient } from "./updateClient";
import type { AutoCheckSource } from "./useUpdate";
import { useUpdate } from "./useUpdate";
import type { UpdateInfo } from "./updateState";

const INFO: UpdateInfo = { version: "0.0.2", currentVersion: "0.0.1", notes: "notes" };

function fakeStore(initial = true): AutoCheckSource & { saved: boolean[] } {
  let value = initial;
  const saved: boolean[] = [];
  return { saved, load: () => value, save: (v) => { value = v; saved.push(v); } };
}

describe("useUpdate", () => {
  it("checkNow surfaces an available update", async () => {
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() => useUpdate({ client, store: fakeStore() }));

    await act(async () => {
      await result.current.checkNow();
    });

    expect(result.current.state.status).toBe("available");
    expect(result.current.state.updateInfo).toEqual(INFO);
  });

  it("checkNow reports up-to-date when there is no update", async () => {
    const client = makeFakeUpdateClient({ update: null });
    const { result } = renderHook(() => useUpdate({ client, store: fakeStore() }));
    await act(async () => {
      await result.current.checkNow();
    });
    expect(result.current.state.status).toBe("up-to-date");
  });

  it("checkNow surfaces a check error", async () => {
    const client = makeFakeUpdateClient({ checkError: "offline" });
    const { result } = renderHook(() => useUpdate({ client, store: fakeStore() }));
    await act(async () => {
      await result.current.checkNow();
    });
    expect(result.current.state.status).toBe("error");
    expect(result.current.state.error).toBe("offline");
  });

  it("download streams progress to ready", async () => {
    const client = makeFakeUpdateClient({
      update: INFO,
      progressTicks: [
        { downloaded: 0, total: 100 },
        { downloaded: 100, total: 100 },
      ],
    });
    const { result } = renderHook(() => useUpdate({ client, store: fakeStore() }));
    await act(async () => {
      await result.current.checkNow();
    });
    await act(async () => {
      await result.current.download();
    });
    expect(result.current.state.status).toBe("ready");
  });

  it("download surfaces a download error", async () => {
    const client = makeFakeUpdateClient({ update: INFO, downloadError: "disk full" });
    const { result } = renderHook(() => useUpdate({ client, store: fakeStore() }));
    await act(async () => {
      await result.current.checkNow();
    });
    await act(async () => {
      await result.current.download();
    });
    expect(result.current.state.status).toBe("error");
    expect(result.current.state.error).toBe("disk full");
  });

  it("restart calls the client's relaunch", async () => {
    const onRelaunch = vi.fn();
    const client = makeFakeUpdateClient({ update: INFO, onRelaunch });
    const { result } = renderHook(() => useUpdate({ client, store: fakeStore() }));
    await act(async () => {
      await result.current.restart();
    });
    expect(onRelaunch).toHaveBeenCalledOnce();
  });

  it("skip dismisses the offered version", async () => {
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() => useUpdate({ client, store: fakeStore() }));
    await act(async () => {
      await result.current.checkNow();
    });
    act(() => {
      result.current.skip();
    });
    expect(result.current.state.dismissedVersion).toBe("0.0.2");
    expect(result.current.state.status).toBe("idle");
  });

  it("setAutoCheck persists to the store and updates state", () => {
    const store = fakeStore(true);
    const client = makeFakeUpdateClient({ update: null });
    const { result } = renderHook(() => useUpdate({ client, store }));
    act(() => {
      result.current.setAutoCheck(false);
    });
    expect(store.saved).toEqual([false]);
    expect(result.current.state.autoCheckEnabled).toBe(false);
  });

  it("never checks on its own — mounting stays idle (scheduling lives in useUpdateAuthority)", async () => {
    const client = makeFakeUpdateClient({ update: INFO });
    const { result } = renderHook(() => useUpdate({ client, store: fakeStore(true) }));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.state.status).toBe("idle");
  });
});
