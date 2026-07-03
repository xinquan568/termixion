// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-74: component-level E2E of the tab strip against the Vite dev-server webview. There is NO
// backend here (open_pty rejects), so every tab keeps its "Shell" placeholder title and a dead
// pane — which is exactly what these tests need: strip rendering, add via `+`, close via `×`
// (neighbor activation), activate-by-click with keep-alive host visibility, active styling, and
// pointer-drag reorder over real boundingRects. The keyboard chords (⌘1..9, menu ⌘T/⌘W) route
// through the OS/menu and are covered headless (tabKeymap + App suites) and by the packaged
// `--smoke` tier — dev-server ⌘-chords are browser-owned and flaky, so they are not driven here.
import { test, expect } from "@playwright/test";

const ACTIVE = /tab-strip__tab--active/;

test("boots with one Shell tab; + adds an active tab; × falls back to the neighbor", async ({
  page,
}) => {
  await page.goto("/");

  // One tab after boot (StrictMode's double effects must not open two — the ref guard).
  const tabs = page.locator(".tab-strip__tab");
  await expect(page.getByTestId("tab-strip")).toBeVisible();
  await expect(tabs).toHaveCount(1);
  await expect(page.getByTestId("tab-1")).toContainText("Shell");
  await expect(page.getByTestId("tab-1")).toHaveClass(ACTIVE);
  await expect(page.getByTestId("tab-host-1")).toBeVisible();

  // + opens a second tab, which becomes the active one; tab 1's host hides but stays attached
  // (keep-alive: hidden, not unmounted).
  await page.getByTestId("tab-new").click();
  await expect(tabs).toHaveCount(2);
  await expect(page.getByTestId("tab-2")).toHaveClass(ACTIVE);
  await expect(page.getByTestId("tab-1")).not.toHaveClass(ACTIVE);
  await expect(page.getByTestId("tab-host-2")).toBeVisible();
  await expect(page.getByTestId("tab-host-1")).toBeHidden();
  await expect(page.getByTestId("tab-host-1")).toBeAttached();

  // × on the active tab: it closes and activation falls to the neighbor (iTerm2 rule).
  await page.getByTestId("tab-close-2").click();
  await expect(tabs).toHaveCount(1);
  await expect(page.getByTestId("tab-2")).toHaveCount(0);
  await expect(page.getByTestId("tab-1")).toHaveClass(ACTIVE);
  await expect(page.getByTestId("tab-host-1")).toBeVisible();
});

test("clicking a background tab activates it and swaps the visible host", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-new").click();
  await expect(page.getByTestId("tab-2")).toHaveClass(ACTIVE);

  await page.getByTestId("tab-1").click();

  await expect(page.getByTestId("tab-1")).toHaveClass(ACTIVE);
  await expect(page.getByTestId("tab-2")).not.toHaveClass(ACTIVE);
  await expect(page.getByTestId("tab-host-1")).toBeVisible();
  await expect(page.getByTestId("tab-host-2")).toBeHidden();
  // Keep-alive: the deactivated host is hidden, never removed.
  await expect(page.getByTestId("tab-host-2")).toBeAttached();
});

test("a mouse drag past the neighbor's midpoint reorders the tabs", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-new").click();
  await expect(page.locator(".tab-strip__tab")).toHaveCount(2);

  const box1 = await page.getByTestId("tab-1").boundingBox();
  const box2 = await page.getByTestId("tab-2").boundingBox();
  expect(box1).not.toBeNull();
  expect(box2).not.toBeNull();

  // Drag tab-1 from its center to well past tab-2's midpoint (hoverIndexFromPoint flips there).
  await page.mouse.move(box1!.x + box1!.width / 2, box1!.y + box1!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2!.x + box2!.width * 0.75, box2!.y + box2!.height / 2, { steps: 8 });
  await page.mouse.up();

  const order = await page
    .locator(".tab-strip__tab")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
  expect(order).toEqual(["tab-2", "tab-1"]);
  // A drag is a reorder, not a click: the active tab (2) kept its identity across the move.
  await expect(page.getByTestId("tab-2")).toHaveClass(ACTIVE);
});
