// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import { describe, expect, it, vi } from "vitest";
import { createDispatcher } from "./dispatch";
import type { Command, CommandContext } from "./registry";

const ctx = {} as CommandContext;

function cmds(): Command[] {
  return [
    { id: "a.run", title: "A", category: "X", run: vi.fn() },
    { id: "b.guarded", title: "B", category: "X", run: vi.fn(), when: () => false },
    { id: "c.arg", title: "C", category: "X", run: vi.fn() },
  ];
}

describe("createDispatcher", () => {
  it("runs a known command and records it in the MRU", () => {
    const list = cmds();
    const d = createDispatcher(list, ctx);
    expect(d.dispatch("a.run")).toBe(true);
    expect(list[0].run).toHaveBeenCalledTimes(1);
    expect(d.recentCommandIds()).toEqual(["a.run"]);
  });

  it("an unknown id is inert and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = createDispatcher(cmds(), ctx);
    expect(d.dispatch("nope")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a guarded-off command is inert (no run, no MRU) and does NOT warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = cmds();
    const d = createDispatcher(list, ctx);
    expect(d.dispatch("b.guarded")).toBe(false);
    expect(list[1].run).not.toHaveBeenCalled();
    expect(d.recentCommandIds()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("passes the arg through to run()", () => {
    const list = cmds();
    createDispatcher(list, ctx).dispatch("c.arg", "night");
    expect(list[2].run).toHaveBeenCalledWith(ctx, "night");
  });

  it("MRU is most-recent-first and dedupes a re-run to the front", () => {
    const d = createDispatcher(cmds(), ctx);
    d.dispatch("a.run");
    d.dispatch("c.arg");
    d.dispatch("a.run");
    expect(d.recentCommandIds()).toEqual(["a.run", "c.arg"]);
  });
});
