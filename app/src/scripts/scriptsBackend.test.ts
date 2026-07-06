// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import { describe, expect, it, vi } from "vitest";
import type { EventBus } from "../ipc/eventBus";
import { listScripts, onScriptsChanged, openScriptsDir } from "./scriptsBackend";

const ENTRY = {
  relPath: "work/proj-x.sh",
  name: "proj-x",
  sourceLine: "source '/home/me/.config/termixion/scripts/work/proj-x.sh'",
};

describe("listScripts", () => {
  it("returns the backend entries and shape-filters junk", async () => {
    const invoke = vi.fn().mockResolvedValue([ENTRY, { relPath: 1 }, null, { name: "x" }]);
    const out = await listScripts(invoke);
    expect(out).toEqual([ENTRY]);
    expect(invoke).toHaveBeenCalledWith("scripts_list");
  });

  it("degrades to [] when there is no backend (invoke rejects)", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("no runtime"));
    expect(await listScripts(invoke)).toEqual([]);
  });

  it("degrades to [] on a non-array result", async () => {
    const invoke = vi.fn().mockResolvedValue("nope");
    expect(await listScripts(invoke)).toEqual([]);
  });
});

describe("openScriptsDir", () => {
  it("invokes scripts_open_dir", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    await openScriptsDir(invoke);
    expect(invoke).toHaveBeenCalledWith("scripts_open_dir");
  });
});

describe("onScriptsChanged", () => {
  it("fires the handler on each event and stops after teardown", async () => {
    let fire: (() => void) | undefined;
    const unlisten = vi.fn();
    const bus: EventBus = {
      emit: () => {},
      listen: (_event, cb) => {
        fire = () => cb(null);
        return Promise.resolve(unlisten);
      },
    };
    const handler = vi.fn();
    const teardown = onScriptsChanged(handler, bus);
    await Promise.resolve(); // let the listen promise resolve
    fire?.();
    fire?.();
    expect(handler).toHaveBeenCalledTimes(2);
    teardown();
    expect(unlisten).toHaveBeenCalledTimes(1);
    fire?.();
    expect(handler).toHaveBeenCalledTimes(2); // silent after teardown
  });

  it("is inert without a runtime (listen rejects)", () => {
    const bus: EventBus = {
      emit: () => {},
      listen: () => Promise.reject(new Error("no runtime")),
    };
    const handler = vi.fn();
    // Must not throw; teardown is safe to call.
    const teardown = onScriptsChanged(handler, bus);
    expect(() => teardown()).not.toThrow();
  });
});
