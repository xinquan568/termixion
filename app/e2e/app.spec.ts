// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// D-3: component-level coverage of the webview boot. The live PTY needs the Tauri runtime (absent in
// the plain dev server), so this verifies the surface renders, owns the whole window, and re-fits on
// resize; the live PTY round-trip is the packaged `--smoke` (the authoritative gate).
import { test, expect } from "@playwright/test";

test("the terminal webview boots, fills the window, and has no in-page chrome", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/");

  // The xterm.js terminal surface mounts into the page.
  const xterm = page.locator(".xterm");
  await expect(xterm).toBeAttached();

  // Issue 1: no in-page chrome — no program-name heading, no core-version status line.
  await expect(page.locator("h1")).toHaveCount(0);
  await expect(page.getByTestId("core-version")).toHaveCount(0);

  // Issue 1: the terminal is flush to the top-left and spans (about) the whole viewport — no body
  // margin/padding. The fit addon leaves at most a sub-cell remainder at the bottom-right.
  const box = await xterm.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeLessThanOrEqual(2);
  expect(box!.y).toBeLessThanOrEqual(2);
  expect(box!.width).toBeGreaterThan(900 * 0.95);
  expect(box!.height).toBeGreaterThan(600 * 0.95);
});

test("the terminal content re-fits as the window grows (responsive)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 480 });
  await page.goto("/");

  const screen = page.locator(".xterm-screen");
  await expect(screen).toBeAttached();
  // The number of columns the grid fits is encoded in xterm-screen's width; capture it small...
  const smallWidth = (await screen.boundingBox())!.width;

  // ...then grow the window and let the ResizeObserver re-fit the grid.
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect
    .poll(async () => (await screen.boundingBox())!.width)
    .toBeGreaterThan(smallWidth);
});
