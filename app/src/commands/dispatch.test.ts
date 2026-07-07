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

  // trmx-144: per-dispatch origin — close commands must distinguish user gestures ("user") from
  // control-channel requests ("remote", which bypass the busy-close confirm).
  describe("per-dispatch origin (trmx-144)", () => {
    function probe() {
      let runOrigin: string | undefined;
      let whenOrigin: string | undefined;
      const commands: Command[] = [
        {
          id: "o.probe",
          title: "O",
          category: "X",
          run: (c) => {
            runOrigin = c.origin;
          },
          when: (c) => {
            whenOrigin = c.origin;
            return true;
          },
        },
      ];
      return { commands, runOrigin: () => runOrigin, whenOrigin: () => whenOrigin };
    }

    it("run (and when) see ctx.origin === 'user' by default", () => {
      const p = probe();
      expect(createDispatcher(p.commands, ctx).dispatch("o.probe")).toBe(true);
      expect(p.runOrigin()).toBe("user");
      expect(p.whenOrigin()).toBe("user");
    });

    it("dispatch(id, arg, 'remote') → ctx.origin === 'remote' in run and when", () => {
      const p = probe();
      expect(createDispatcher(p.commands, ctx).dispatch("o.probe", undefined, "remote")).toBe(true);
      expect(p.runOrigin()).toBe("remote");
      expect(p.whenOrigin()).toBe("remote");
    });

    it("DELEGATION PIN: ctx methods still reach the underlying impl through App's forwarding proxy", () => {
      // Mirror App.tsx (~1017-1025): the ctx App injects is a Proxy over an EMPTY object whose
      // get-trap returns forwarding functions. The dispatcher must NOT spread it — its per-call
      // origin wrapper has to delegate every other property via Reflect.get so the trap still fires.
      const impl = { newTab: vi.fn() };
      const forwarding = new Proxy({} as CommandContext, {
        get(_target, prop: string) {
          return (...args: unknown[]) =>
            (impl as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
        },
      });
      let seenOrigin: string | undefined;
      const commands: Command[] = [
        {
          id: "t.new",
          title: "T",
          category: "X",
          run: (c) => {
            seenOrigin = c.origin; // must be the injected origin, NOT a forwarding function
            c.newTab();
          },
        },
      ];
      expect(createDispatcher(commands, forwarding).dispatch("t.new", undefined, "remote")).toBe(
        true,
      );
      expect(impl.newTab).toHaveBeenCalledTimes(1);
      expect(seenOrigin).toBe("remote");
    });
  });
});
