// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the auto-check persistence spec — round-trips + defensive defaults through a fake store.
import { describe, expect, it } from "vitest";
import { makeAutoCheckStore, type KeyValueStore } from "./autoCheckStore";

function fakeStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("makeAutoCheckStore", () => {
  it("defaults to enabled when nothing is stored", () => {
    expect(makeAutoCheckStore(fakeStore()).load()).toBe(true);
  });

  it("round-trips save → load", () => {
    const store = makeAutoCheckStore(fakeStore());
    store.save(false);
    expect(store.load()).toBe(false);
    store.save(true);
    expect(store.load()).toBe(true);
  });

  it("treats any non-\"false\" stored value as enabled", () => {
    expect(makeAutoCheckStore(fakeStore({ "termixion.update.autoCheck": "garbage" })).load()).toBe(true);
    expect(makeAutoCheckStore(fakeStore({ "termixion.update.autoCheck": "false" })).load()).toBe(false);
  });

  it("degrades to the default when the backend throws", () => {
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const store = makeAutoCheckStore(throwing);
    expect(store.load()).toBe(true);
    expect(() => store.save(false)).not.toThrow();
  });

  it("degrades safely when no backend is available", () => {
    const store = makeAutoCheckStore(undefined);
    expect(store.load()).toBe(true);
    expect(() => store.save(false)).not.toThrow();
  });
});
