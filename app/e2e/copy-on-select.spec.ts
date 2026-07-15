// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-180: the real-wiring tier for auto-copy-on-select — the tier the trmx-95 unit suite cannot
// reach. Real xterm.js (Vite `/@id/` specifier), the real `attachCopyOnSelect` wiring, REAL browser
// pointer events from Playwright's mouse, real pointer capture, and real timers — only the write
// sink is injected (the dev-server harness has no Tauri runtime, so the native IPC sink is a
// designed no-op here; assertions terminate at the sink boundary, per D-3). Pins: a drag-selection
// reaches the sink exactly once with exactly the terminal's own selection bytes, and a double-click
// word-selection auto-copies the word.
import { test, expect, type Page } from "@playwright/test";

/** Mount a real terminal + the real auto-copy wiring with a recording sink; return cell geometry. */
async function mountCopyOnSelect(page: Page, content: string) {
  await page.goto("/");
  return await page.evaluate(async (text) => {
    // Real xterm via Vite's resolved specifier (CJS↔ESM interop: class on the namespace or default).
    const xtermNs = (await import(/* @vite-ignore */ "/@id/@xterm/xterm")) as Record<
      string,
      unknown
    > & { default?: Record<string, unknown> };
    const Terminal = (xtermNs.Terminal ?? xtermNs.default?.Terminal) as new (
      opts: object,
    ) => XtermLike;
    const { attachCopyOnSelect } = (await import(
      /* @vite-ignore */ "/src/terminal/copyOnSelect.ts"
    )) as {
      attachCopyOnSelect: (
        host: HTMLElement,
        terminal: unknown,
        writeClipboard: (t: string) => void,
      ) => () => void;
    };

    // A real, sized host ABOVE the app's own UI so the mouse gesture lands here.
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;top:0;left:0;width:480px;height:160px;z-index:99999;background:#000;";
    document.body.appendChild(host);

    const term = new Terminal({ rows: 6, cols: 40 });
    term.open(host);

    const w = window as unknown as { __trmxCopies: string[]; __trmxSelection: () => string };
    w.__trmxCopies = [];
    w.__trmxSelection = () => term.getSelection();
    attachCopyOnSelect(host, term, (t) => w.__trmxCopies.push(t));

    await new Promise<void>((resolve) => term.write(text, resolve));

    // Wait for xterm to measure the cell grid — until then the screen box has no usable geometry.
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const screen = () => host.querySelector(".xterm-screen");
    for (let i = 0; i < 120 && (screen()?.getBoundingClientRect().width ?? 0) < 10; i++) {
      await frame();
    }
    const rect = (screen() as Element).getBoundingClientRect();
    return { x: rect.x, y: rect.y, cellW: rect.width / 40, cellH: rect.height / 6 };

    interface XtermLike {
      open(el: HTMLElement): void;
      write(data: string, cb?: () => void): void;
      getSelection(): string;
      hasSelection(): boolean;
      onSelectionChange(handler: () => void): { dispose(): void };
    }
  }, content);
}

const copies = (page: Page) =>
  page.evaluate(() => (window as unknown as { __trmxCopies: string[] }).__trmxCopies);

test("a real mouse drag-selection reaches the sink exactly once, byte-identical to getSelection()", async ({
  page,
}) => {
  const g = await mountCopyOnSelect(page, "hello world");
  const y = g.y + g.cellH * 0.5;

  // Drag across "hello": press in cell col 0, release in cell col 4 (real pointer events,
  // real pointer capture, real {pointerup, lostpointercapture} delivery order).
  await page.mouse.move(g.x + g.cellW * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(g.x + g.cellW * 4.5, y, { steps: 4 });
  await page.mouse.up();

  // The copy is deferred one real tick — poll for arrival.
  await expect.poll(async () => (await copies(page)).length).toBe(1);
  // Settle a beat, then re-assert EXACTLY once (no duplicate from trailing selection ticks).
  await page.waitForTimeout(250);
  const written = await copies(page);
  expect(written).toHaveLength(1);

  // The trmx-95 trust anchor, now at the real-wiring tier: the sink got the terminal's own bytes.
  const selection = await page.evaluate(() =>
    (window as unknown as { __trmxSelection: () => string }).__trmxSelection(),
  );
  expect(written[0]).toBe(selection);
  expect(written[0]).toContain("hell"); // and it was a real multi-cell selection
});

test("a double-click word-selection auto-copies the word", async ({ page }) => {
  const g = await mountCopyOnSelect(page, "hello world");

  // Double-click inside "world" (cols 6-10) → xterm selects the word; the second click's
  // release completes the gesture and the settled word selection is copied.
  await page.mouse.dblclick(g.x + g.cellW * 8, g.y + g.cellH * 0.5);

  await expect
    .poll(async () => {
      const w = await copies(page);
      return w.at(-1) ?? "";
    })
    .toBe("world");
});
