// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import { describe, expect, it, vi } from "vitest";
import type { EventBus } from "../ipc/eventBus";
import { onKeysChanged, readKeys } from "./keysBackend";

describe("readKeys", () => {
  it("returns the string map from keys_read", async () => {
    const invoke = vi.fn().mockResolvedValue({ "cmd+d": "pane.split-below", "cmd+j": "none" });
    expect(await readKeys(invoke as never)).toEqual({ "cmd+d": "pane.split-below", "cmd+j": "none" });
    expect(invoke).toHaveBeenCalledWith("keys_read");
  });

  it("degrades to {} without a backend / on a non-map", async () => {
    expect(await readKeys(vi.fn().mockRejectedValue(new Error("no runtime")) as never)).toEqual({});
    expect(await readKeys(vi.fn().mockResolvedValue([1, 2]) as never)).toEqual({});
    expect(await readKeys(vi.fn().mockResolvedValue({ "cmd+d": 3 }) as never)).toEqual({}); // non-string value
  });
});

describe("onKeysChanged", () => {
  it("fires on each event and stops after teardown; inert without a runtime", async () => {
    let fire: (() => void) | undefined;
    const unlisten = vi.fn();
    const bus: EventBus = {
      emit: () => {},
      listen: (_e, cb) => {
        fire = () => cb(null);
        return Promise.resolve(unlisten);
      },
    };
    const handler = vi.fn();
    const teardown = onKeysChanged(handler, bus);
    await Promise.resolve();
    fire?.();
    expect(handler).toHaveBeenCalledTimes(1);
    teardown();
    fire?.();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalled();

    const dead: EventBus = { emit: () => {}, listen: () => Promise.reject(new Error("no runtime")) };
    expect(() => onKeysChanged(vi.fn(), dead)()).not.toThrow();
  });
});
