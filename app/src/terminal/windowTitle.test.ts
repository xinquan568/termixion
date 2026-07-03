// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64: OSC 0/2 window-title forwarding — the attach wiring over a fake terminal slice, plus
// the production Tauri sink's no-runtime safety in jsdom (R8: tests first).
import { describe, expect, it, vi } from "vitest";
import { attachWindowTitle, realSetWindowTitle, type TitleTerminalLike } from "./windowTitle";

/** A fake xterm slice: records the subscribed handler, exposes `emit` + a dispose spy. */
function fakeTitleTerminal() {
  let handler: ((title: string) => void) | undefined;
  const dispose = vi.fn(() => {
    handler = undefined;
  });
  const terminal: TitleTerminalLike = {
    onTitleChange(h) {
      handler = h;
      return { dispose };
    },
  };
  return { terminal, emit: (title: string) => handler?.(title), dispose };
}

describe("attachWindowTitle", () => {
  it("forwards a title event's exact string to setTitle", () => {
    const { terminal, emit } = fakeTitleTerminal();
    const titles: string[] = [];
    attachWindowTitle(terminal, (title) => titles.push(title));
    emit("vim — ~/notes.txt");
    expect(titles).toEqual(["vim — ~/notes.txt"]);
  });

  it("forwards multiple events in order", () => {
    const { terminal, emit } = fakeTitleTerminal();
    const titles: string[] = [];
    attachWindowTitle(terminal, (title) => titles.push(title));
    emit("first");
    emit("second");
    emit("third");
    expect(titles).toEqual(["first", "second", "third"]);
  });

  it("teardown disposes the xterm subscription and stops forwarding", () => {
    const { terminal, emit, dispose } = fakeTitleTerminal();
    const titles: string[] = [];
    const teardown = attachWindowTitle(terminal, (title) => titles.push(title));
    emit("before");
    teardown();
    expect(dispose).toHaveBeenCalledTimes(1);
    emit("after");
    expect(titles).toEqual(["before"]);
  });
});

describe("realSetWindowTitle", () => {
  it("does not throw without a Tauri runtime (jsdom)", async () => {
    // No `window.__TAURI_INTERNALS__` here, so `getCurrentWindow()` throws inside the lazy-import
    // chain; the sink must swallow that (cf. realObserveSettings in TerminalView.tsx). A leak
    // would surface as an unhandled rejection and fail the run.
    expect(() => realSetWindowTitle("no runtime")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
