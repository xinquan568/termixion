// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: component-level coverage of the settings-window surface in the webview (the dev server
// has no Tauri runtime — window creation itself is covered by the packaged --smoke + the manual
// dev pass). `?window=settings` must route to the settings surface with the vmark chrome: sidebar
// (search + Terminal/About), the centered title, drag-region strips, and the two pages' rows.
import { test, expect } from "@playwright/test";

test("?window=settings renders the settings surface with the vmark chrome", async ({ page }) => {
  await page.goto("/?window=settings");

  // Not the terminal surface —
  await expect(page.locator(".xterm")).toHaveCount(0);
  // — but the settings shell: search field, both nav entries, centered title.
  await expect(page.getByPlaceholder("Search settings…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Terminal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "About" })).toBeVisible();
  await expect(page.locator(".tx-settings__title")).toHaveText("Settings");

  // The Overlay-titlebar chrome that makes the window draggable (sidebar strip, content strip,
  // title overlay).
  const dragRegions = page.locator("[data-tauri-drag-region]");
  await expect(dragRegions).toHaveCount(3);

  // Default landing: the Terminal page with exactly the two boxed rows.
  await expect(page.getByText("Cursor Style", { exact: true })).toBeVisible();
  await expect(page.getByText("Cursor Blink", { exact: true })).toBeVisible();
  await expect(page.locator(".tx-setting-row")).toHaveCount(2);
});

test("?window=settings&section=about lands on the vmark-parity About page", async ({ page }) => {
  await page.goto("/?window=settings&section=about");

  await expect(page.getByText("Automatic updates")).toBeVisible();
  await expect(page.getByText("Check frequency")).toBeVisible();
  await expect(page.getByText("Download updates automatically")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check Now" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset to Defaults" })).toBeVisible();
  // The identity links, stacked with icons.
  await expect(page.getByRole("button", { name: "Website" })).toBeVisible();
  await expect(page.getByRole("button", { name: "GitHub" })).toBeVisible();
});

test("the plain root still boots the terminal surface", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".xterm")).toBeAttached();
  await expect(page.getByPlaceholder("Search settings…")).toHaveCount(0);
});
