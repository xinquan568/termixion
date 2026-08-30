// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-247: the window-lifecycle helpers became a public `ipc/` surface when they moved out of
// App.tsx, so they get their own test. Each asserts the command name it sends and — the part that
// actually matters — that a rejected invoke is SWALLOWED: with no Tauri runtime there is nothing to
// close or quit, and a throw here would surface as an unhandled rejection in a plain browser tab.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeSpy = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    void args;
    return Promise.resolve(null);
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeSpy, Channel: class {} }));

import { realCloseAcknowledged, realCloseWindow, realQuitConfirmed } from "./window";

beforeEach(() => invokeSpy.mockClear());

describe("ipc/window (trmx-247)", () => {
  it("realCloseWindow asks the backend rather than closing natively", () => {
    realCloseWindow();
    expect(invokeSpy.mock.calls.map((c) => c[0])).toEqual(["webview_close_request"]);
  });

  it("realQuitConfirmed sends the webview's approval", () => {
    realQuitConfirmed();
    expect(invokeSpy.mock.calls.map((c) => c[0])).toEqual(["quit_confirmed"]);
  });

  it("realCloseAcknowledged carries the generation being answered", async () => {
    await realCloseAcknowledged(7);
    expect(invokeSpy).toHaveBeenCalledWith("close_acknowledged", { generation: 7 });
  });

  it("realCloseAcknowledged RESOLVES when there is no Tauri runtime", async () => {
    // The one swallowing path that is directly observable: it returns a promise, so a missing
    // error handler would surface as a rejection here. The two void helpers swallow the same way
    // (`.catch` in window.ts); their fire-and-forget shape is not assertable without also
    // suppressing the rejection this would be testing for, so it is left to the production catch.
    invokeSpy.mockImplementation(() => Promise.reject(new Error("no runtime")));
    await expect(realCloseAcknowledged(1)).resolves.toBeUndefined();
    invokeSpy.mockImplementation(() => Promise.resolve(null));
  });
});
