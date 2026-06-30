// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-41: end-to-end regression guard against REAL xterm.js (in Chromium, where the canvas/WebGL the
// renderer needs actually works) for "the scrollbar doesn't appear while scrolling, unlike Kitty".
//
// The headless unit tests use a fake terminal, so they cannot prove the *cause*: xterm SUPPRESSES its
// public `onScroll` event for user-initiated viewport scrolling (the Viewport requests its scrollLines
// with `suppressScrollEvent: true`). This test drives a real Terminal + the real `attachScrollbar`,
// scrolls it back the way a user's wheel does, and asserts BOTH halves of the diagnosis:
//   1. the real `onScroll` does NOT fire on that user scroll (the bug — why wiring only to onScroll fails)
//   2. the overlay nonetheless becomes visible (the fix — we also listen to the viewport's native scroll)
import { test, expect } from "@playwright/test";

test("the Kitty-style scrollbar appears when the user scrolls back (real xterm)", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    // Real xterm via Vite's resolved specifier; the real overlay wiring from app source. Vite's CJS↔ESM
    // interop may surface the class on the namespace or on `default`, so resolve both.
    const xtermNs = (await import(/* @vite-ignore */ "/@id/@xterm/xterm")) as Record<
      string,
      unknown
    > & { default?: Record<string, unknown> };
    const Terminal = (xtermNs.Terminal ?? xtermNs.default?.Terminal) as new (
      opts: object,
    ) => XtermLike;
    const { attachScrollbar } = await import(/* @vite-ignore */ "/src/terminal/scrollbar.ts");

    // A real, sized host (the scrollbar reads host.clientWidth/Height for its geometry).
    const host = document.createElement("div");
    host.style.cssText = "position:relative;width:400px;height:200px;";
    document.body.appendChild(host);

    const term = new Terminal({ rows: 6, cols: 40, scrollback: 1000 });
    term.open(host);
    attachScrollbar(host, term as unknown as Parameters<typeof attachScrollbar>[1]);

    // Fill far past the 6 visible rows so there is real scrollback to scroll into.
    await new Promise<void>((resolve) => {
      let s = "";
      for (let i = 0; i < 100; i++) s += `line ${i}\r\n`;
      term.write(s, resolve);
    });

    const overlay = host.querySelector(".termixion-scrollbar") as HTMLElement;
    const viewport = host.querySelector(".xterm-viewport") as HTMLElement;

    // Wait for xterm to measure the cell grid and expand the viewport's scroll area — until then there is
    // nothing to scroll into and rowHeight is unmeasured.
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    for (let i = 0; i < 120 && viewport.scrollHeight <= viewport.clientHeight; i++) await frame();

    const hiddenAtBottom = overlay.style.display === "none";

    // Count public onScroll fires from here on — the writes above already settled.
    let onScrollFires = 0;
    term.onScroll(() => onScrollFires++);

    const ydispBefore = term.buffer.active.viewportY;

    // Reproduce a user wheel scroll to the very top: set the viewport scrollTop and let xterm's own
    // 'scroll' handler translate it (exactly what a real wheel does). This is the path that fires NO
    // onScroll.
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));

    // The native scroll handling is synchronous, but allow a frame for safety.
    await frame();

    const ydispAfter = term.buffer.active.viewportY;
    const visibleAfterScroll = overlay.style.display !== "none";

    term.dispose();
    host.remove();

    return {
      hiddenAtBottom,
      scrolledBack: ydispAfter < ydispBefore, // the viewport actually moved up
      onScrollFires, // expected 0 — real xterm suppresses onScroll on user scroll
      visibleAfterScroll, // expected true — the fix surfaces the bar via the viewport scroll event
    };

    interface XtermLike {
      open(el: HTMLElement): void;
      write(data: string, cb?: () => void): void;
      onScroll(cb: (y: number) => void): { dispose(): void };
      dispose(): void;
      buffer: { active: { viewportY: number } };
    }
  });

  // The bar is correctly hidden while pinned to the live bottom (Kitty `scrolled` policy).
  expect(result.hiddenAtBottom).toBe(true);
  // Sanity: the user scroll really moved the viewport into the scrollback.
  expect(result.scrolledBack).toBe(true);
  // Root cause: real xterm fires NO public onScroll for this user scroll — so wiring only to onScroll
  // (the original bug) would leave the bar hidden the whole time the user scrolls.
  expect(result.onScrollFires).toBe(0);
  // Fix: the overlay appears anyway, because we also listen to the viewport's native scroll event.
  expect(result.visibleAfterScroll).toBe(true);
});
