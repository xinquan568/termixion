// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-99 (FR-7b, test-first): the OSC 133 parser + prompt state machine, incl. the re-sync table.
import { describe, it, expect, vi } from "vitest";
import {
  parseOsc133,
  stepPrompt,
  initialPrompt,
  attachOsc133,
  type Osc133TerminalLike,
  type PromptTransition,
} from "./osc133";

describe("parseOsc133", () => {
  it("parses A/B/C with no params", () => {
    expect(parseOsc133("A")).toEqual({ kind: "A" });
    expect(parseOsc133("B")).toEqual({ kind: "B" });
    expect(parseOsc133("C")).toEqual({ kind: "C" });
  });
  it("parses D with a numeric exit code and ignores extra iTerm2 sub-params", () => {
    expect(parseOsc133("D;0")).toEqual({ kind: "D", exit: 0 });
    expect(parseOsc133("D;1")).toEqual({ kind: "D", exit: 1 });
    expect(parseOsc133("D;130;something")).toEqual({ kind: "D", exit: 130 });
  });
  it("D with absent / non-numeric exit → exit undefined", () => {
    expect(parseOsc133("D")).toEqual({ kind: "D", exit: undefined });
    expect(parseOsc133("D;abc")).toEqual({ kind: "D", exit: undefined });
  });
  it("junk / unknown sub-commands → null", () => {
    expect(parseOsc133("Z")).toBeNull();
    expect(parseOsc133("")).toBeNull();
    expect(parseOsc133("P;foo=bar")).toBeNull(); // iTerm2 133;P properties — not implemented
  });
});

describe("stepPrompt — the happy A→B→C→D cycle", () => {
  it("C runs (busy true), D finishes (busy false + exit)", () => {
    let s = initialPrompt();
    let t = stepPrompt(s, { kind: "A" });
    expect(t.busy).toBe(false);
    ({ state: s } = (t = stepPrompt(t.state, { kind: "B" })));
    expect(t.busy).toBe(false);
    t = stepPrompt(s, { kind: "C" });
    expect(t).toMatchObject({ busy: true, busyChanged: true });
    t = stepPrompt(t.state, { kind: "D", exit: 3 });
    expect(t).toMatchObject({ busy: false, busyChanged: true, exitCode: 3 });
  });
});

describe("stepPrompt — re-sync (never spurious, never stuck)", () => {
  it("A while running = the command ended without D → clears busy", () => {
    const running = stepPrompt(initialPrompt(), { kind: "C" });
    const t = stepPrompt(running.state, { kind: "A" });
    expect(t).toMatchObject({ busy: false, busyChanged: true });
  });
  it("double C stays running with busyChanged false", () => {
    const running = stepPrompt(initialPrompt(), { kind: "C" });
    const t = stepPrompt(running.state, { kind: "C" });
    expect(t).toMatchObject({ busy: true, busyChanged: false });
  });
  it("D without a preceding C reports idle (no spurious busy)", () => {
    const t = stepPrompt(initialPrompt(), { kind: "D", exit: 0 });
    expect(t).toMatchObject({ busy: false, busyChanged: false });
  });
});

describe("attachOsc133 — handler discipline + machine ownership", () => {
  function fakeTerm() {
    let cb: ((data: string) => boolean) | undefined;
    const disposed = { value: false };
    const terminal: Osc133TerminalLike = {
      parser: {
        registerOscHandler: (_id, callback) => {
          cb = callback;
          return { dispose: () => (disposed.value = true) };
        },
      },
    };
    return { terminal, feed: (d: string) => cb?.(d), disposed };
  }

  it("emits the machine transition for each valid marker, always consumes, never throws", () => {
    const f = fakeTerm();
    const emit = vi.fn<(t: PromptTransition) => void>();
    const teardown = attachOsc133(f.terminal, emit);
    expect(f.feed("C")).toBe(true); // consumed
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ busy: true, busyChanged: true }));
    expect(f.feed("D;1")).toBe(true);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ busy: false, exitCode: 1 }));
    // junk is inert but still consumed
    emit.mockClear();
    expect(f.feed("garbage;stuff")).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    teardown();
    expect(f.disposed.value).toBe(true);
  });

  it("A/B/C/D each own the state across calls (a session-owned machine)", () => {
    const f = fakeTerm();
    const seen: boolean[] = [];
    attachOsc133(f.terminal, (t) => seen.push(t.busy));
    f.feed("A");
    f.feed("B");
    f.feed("C"); // running
    f.feed("D;0"); // done
    expect(seen).toEqual([false, false, true, false]);
  });
});
