// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the settings-menu bridge spec — a fake `listen` drives open, and unlisten fires on unmount.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OPEN_SETTINGS_EVENT, useSettingsMenu, type ListenFn } from "./useSettingsMenu";

/** A fake `listen` that captures the handler so a test can trigger the event. */
function fakeListen() {
  let handler: (() => void) | undefined;
  const unlisten = vi.fn();
  const listen: ListenFn = async (event, h) => {
    expect(event).toBe(OPEN_SETTINGS_EVENT);
    handler = h;
    return unlisten;
  };
  return { listen, fire: () => handler?.(), unlisten };
}

describe("useSettingsMenu", () => {
  it("starts closed", () => {
    const { listen } = fakeListen();
    const { result } = renderHook(() => useSettingsMenu(listen));
    expect(result.current.open).toBe(false);
  });

  it("opens when the open-settings event fires", async () => {
    const f = fakeListen();
    const { result } = renderHook(() => useSettingsMenu(f.listen));
    // let the async subscription resolve, then fire the event
    await act(async () => {});
    act(() => f.fire());
    expect(result.current.open).toBe(true);
  });

  it("openSettings and close flip the flag directly", () => {
    const { listen } = fakeListen();
    const { result } = renderHook(() => useSettingsMenu(listen));
    act(() => result.current.openSettings());
    expect(result.current.open).toBe(true);
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
  });

  it("unsubscribes on unmount", async () => {
    const f = fakeListen();
    const { unmount } = renderHook(() => useSettingsMenu(f.listen));
    await act(async () => {});
    unmount();
    expect(f.unlisten).toHaveBeenCalledOnce();
  });
});
