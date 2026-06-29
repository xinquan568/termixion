// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-41 (test-first): the `attachScrollbar` wiring over a small terminal interface. We drive a fake
// terminal (no real xterm) and assert that scroll / buffer-change events recompute the overlay, that the
// overlay appears only while scrolled back, and that dispose() unsubscribes and removes the element.
import { describe, it, expect, vi } from "vitest";
import { attachScrollbar, type ScrollbarTerminalLike } from "./scrollbar";

// A mutable fake of the xterm slice attachScrollbar consumes; the test mutates the buffer then fires the
// captured listener, exactly as xterm would on a real scroll / buffer switch.
function makeFakeTerminal() {
  const active = {
    viewportY: 100,
    baseY: 100, // start pinned to the live bottom → no scrollbar
    length: 124,
    type: "normal" as "normal" | "alternate",
  };
  let scrollHandler: (() => void) | undefined;
  let bufferHandler: (() => void) | undefined;
  const scrollDispose = vi.fn();
  const bufferDispose = vi.fn();

  const terminal: ScrollbarTerminalLike = {
    rows: 24,
    cols: 80,
    options: { theme: { foreground: "#ffffff" } },
    onScroll: (h: () => void) => {
      scrollHandler = h;
      return { dispose: scrollDispose };
    },
    buffer: {
      active,
      onBufferChange: (h: () => void) => {
        bufferHandler = h;
        return { dispose: bufferDispose };
      },
    },
  };

  return {
    terminal,
    active,
    scrollDispose,
    bufferDispose,
    fireScroll: () => scrollHandler?.(),
    fireBufferChange: () => bufferHandler?.(),
  };
}

// jsdom has no layout, so give the host a non-zero measured size for the geometry math.
function makeHost(width = 800, height = 480) {
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: height, configurable: true });
  document.body.appendChild(host);
  return host;
}

describe("attachScrollbar", () => {
  it("mounts a hidden overlay into the host (pinned to the bottom = nothing to show)", () => {
    const host = makeHost();
    const { terminal } = makeFakeTerminal();

    const sb = attachScrollbar(host, terminal);

    const container = host.querySelector(".termixion-scrollbar") as HTMLElement;
    expect(container).not.toBeNull();
    expect(container.style.display).toBe("none");
    sb.dispose();
  });

  it("shows the overlay on scroll-back and re-hides it back at the bottom", () => {
    const host = makeHost();
    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    const container = host.querySelector(".termixion-scrollbar") as HTMLElement;
    const thumb = host.querySelector(".termixion-scrollbar__thumb") as HTMLElement;

    // Scroll back: viewportY < baseY → the bar appears with a positioned thumb.
    fake.active.viewportY = 40;
    fake.fireScroll();
    expect(container.style.display).toBe("");
    expect(thumb.style.height).not.toBe("");

    // Back to the live bottom → hidden again.
    fake.active.viewportY = 100;
    fake.fireScroll();
    expect(container.style.display).toBe("none");

    sb.dispose();
  });

  it("recomputes on a buffer change (alt-screen hides the bar even without a scroll event)", () => {
    const host = makeHost();
    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    const container = host.querySelector(".termixion-scrollbar") as HTMLElement;

    fake.active.viewportY = 40; // scrolled back in the normal buffer
    fake.fireScroll();
    expect(container.style.display).toBe("");

    // A full-screen app switches to the alternate buffer (no onScroll fired) → must hide on bufferChange.
    fake.active.type = "alternate";
    fake.fireBufferChange();
    expect(container.style.display).toBe("none");

    sb.dispose();
  });

  it("dispose() unsubscribes both listeners and removes the overlay", () => {
    const host = makeHost();
    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    expect(host.querySelector(".termixion-scrollbar")).not.toBeNull();

    sb.dispose();

    expect(fake.scrollDispose).toHaveBeenCalledTimes(1);
    expect(fake.bufferDispose).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".termixion-scrollbar")).toBeNull();
  });
});
