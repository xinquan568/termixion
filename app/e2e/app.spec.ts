// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// D-3: component-level coverage of the webview boot. The live PTY needs the Tauri runtime (absent in
// the plain dev server), so this verifies the surface renders, owns the whole window, and re-fits on
// resize; the live PTY round-trip is the packaged `--smoke` (the authoritative gate).
import { test, expect } from "@playwright/test";

test("the terminal webview boots, fills the window below the title bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/");

  // The xterm.js terminal surface mounts into the page.
  const xterm = page.locator(".xterm");
  await expect(xterm).toBeAttached();

  // Issue 1: no stray in-page chrome — no program-name heading, no core-version status line.
  // (trmx-188 added the app-drawn 38px title bar — deliberate chrome, asserted below.)
  await expect(page.locator("h1")).toHaveCount(0);
  await expect(page.getByTestId("core-version")).toHaveCount(0);

  // trmx-188: the title bar owns the very top; the terminal is flush left and starts directly
  // below it. The fit addon leaves at most a sub-cell remainder at the bottom-right.
  // trmx-74: the window ends in the 34px tab strip, so the terminal owns everything between.
  const bar = await page.locator(".title-bar").boundingBox();
  expect(bar).not.toBeNull();
  expect(bar!.y).toBeLessThanOrEqual(1);
  const box = await xterm.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeLessThanOrEqual(2);
  expect(box!.y).toBeLessThanOrEqual(bar!.y + bar!.height + 2);
  expect(box!.width).toBeGreaterThan(900 * 0.95);
  expect(box!.height).toBeGreaterThan((600 - bar!.height - 34) * 0.95);
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

// Sub-pixel/rounding slack for the scroll-position checks below.
const SCROLL_EPSILON_PX = 2;

test("the view stays pinned to the live bottom across resizes (no scroll jump)", async ({
  page,
}) => {
  // trmx-67: a window resize must never yank the view away from the live bottom. In this plain
  // dev-server environment there is no Tauri runtime, so no PTY ever writes into the terminal
  // (useBackend's openPty rejects) and scrollback CANNOT accumulate — the live bottom is
  // scrollTop 0 with zero scrollable overflow. The strongest honest real-DOM assertion is
  // therefore that across a grow AND a shrink re-fit, `.xterm-viewport` stays at its maximum
  // scrollTop (scrollHeight - clientHeight, which stays ~0 here) and never ends up scrolled —
  // i.e. no spurious jump. The deep scrolled-back rewrap cases are covered headless by the
  // Vitest reflowBehavior suite; this e2e pins the real-DOM no-jump signal only.
  await page.setViewportSize({ width: 700, height: 480 });
  await page.goto("/");

  const screen = page.locator(".xterm-screen");
  const viewport = page.locator(".xterm-viewport");
  await expect(screen).toBeAttached();
  await expect(viewport).toBeAttached();

  // Distance of scrollTop below its maximum — ~0 means "at the live bottom, not yanked".
  const distanceFromBottom = () =>
    viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  const scrollTop = () => viewport.evaluate((el) => el.scrollTop);
  const screenWidth = async () => (await screen.boundingBox())!.width;

  // Baseline: the terminal boots at the live bottom, unscrolled.
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(SCROLL_EPSILON_PX);
  await expect.poll(scrollTop).toBe(0);

  // Grow, and first wait until the re-fit demonstrably completed (the grid widened) so the scroll
  // assertions observe the post-reflow state rather than trivially passing pre-resize.
  const smallWidth = await screenWidth();
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(screenWidth).toBeGreaterThan(smallWidth);
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(SCROLL_EPSILON_PX);
  await expect.poll(scrollTop).toBe(0);

  // Shrink back — narrowing is the direction where a rewrap would classically yank the view.
  const grownWidth = await screenWidth();
  await page.setViewportSize({ width: 700, height: 480 });
  await expect.poll(screenWidth).toBeLessThan(grownWidth);
  await expect.poll(distanceFromBottom).toBeLessThanOrEqual(SCROLL_EPSILON_PX);
  await expect.poll(scrollTop).toBe(0);
});
