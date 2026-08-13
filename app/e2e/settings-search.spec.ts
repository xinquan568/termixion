// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-232: the content-search results view, at the REAL CSS layer. jsdom can only assert the
// data-attribute marking (SettingsApp.test.tsx); the actual hiding is a :has() cascade in
// settings-search.css that only a real browser evaluates — these Chromium checks are the
// authoritative half of the visibility guarantee (the shipped WKWebView is accepted on
// compatibility data + vmark precedent; it is not automated here — see the trmx-232 plan).
//
// Harness boundary: the Vite dev server has no Tauri runtime, so config writes reject and only
// the in-memory settings snapshot survives — the toggle case proves in-session effect, not
// durable TOML persistence (that's the settings-store tests' job).
import { test, expect } from "@playwright/test";

const SEARCH = "Search settings…";

test("a row query filters to its panel; the other panels collapse", async ({ page }) => {
  await page.goto("/?window=settings");
  await page.getByPlaceholder(SEARCH).fill("scrollback");

  // The matching row is visible, a non-matching row in the SAME panel is hidden.
  await expect(page.getByText("Scrollback", { exact: true })).toBeVisible();
  await expect(page.getByText("Cursor Style", { exact: true })).toBeHidden();

  // Panels with no match collapse entirely, headings included.
  await expect(page.locator(".tx-search-panel__title", { hasText: "Terminal" })).toBeVisible();
  for (const other of ["Appearance", "Scripts", "About"]) {
    await expect(page.locator(".tx-search-panel__title", { hasText: other })).toBeHidden();
  }
});

test("group searchText makes row-less content reachable (Reveal snippets)", async ({ page }) => {
  await page.goto("/?window=settings");
  await page.getByPlaceholder(SEARCH).fill("reveal");

  // The Shell-integration group carries no matching SettingRow — only its searchText can hit.
  await expect(page.getByRole("button", { name: "Reveal snippets" })).toBeVisible();
  // Non-matching rows are hidden, so the group really was shown by its own mark.
  await expect(page.getByText("Cursor Style", { exact: true })).toBeHidden();
});

test("a page-name query shows that whole panel, including non-matching rows", async ({ page }) => {
  await page.goto("/?window=settings");
  await page.getByPlaceholder(SEARCH).fill("appearance");

  // "Position" does not contain "appearance" — it is visible only via the panel-level match.
  await expect(page.getByText("Position", { exact: true })).toBeVisible();
  await expect(page.getByText("Shortcut hints", { exact: true })).toBeVisible();
  // Other panels are gone, headings included.
  await expect(page.locator(".tx-search-panel__title", { hasText: "Terminal" })).toBeHidden();
  await expect(page.locator(".tx-search-panel__title", { hasText: "About" })).toBeHidden();
});

test("a setting flipped in the results view takes effect and survives leaving it", async ({
  page,
}) => {
  await page.goto("/?window=settings");
  await page.getByPlaceholder(SEARCH).fill("cursor blink");

  const toggle = page.getByRole("switch", { name: "Cursor Blink" });
  await expect(toggle).toHaveAttribute("aria-checked", "false"); // default off (trmx-55)
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // Leave the results view: the flipped value is still what the Terminal page shows (in-session).
  await page.getByPlaceholder(SEARCH).fill("");
  await expect(page.getByRole("switch", { name: "Cursor Blink" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("clearing the query restores the single-page view", async ({ page }) => {
  await page.goto("/?window=settings");
  await page.getByPlaceholder(SEARCH).fill("font");
  await expect(page.locator("[data-settings-panel]")).toHaveCount(4);

  await page.getByPlaceholder(SEARCH).fill("");
  await expect(page.locator("[data-settings-panel]")).toHaveCount(0);
  // Back on the default Terminal page, everything visible again.
  await expect(page.getByText("Cursor Style", { exact: true })).toBeVisible();
});

test("a no-match query shows the empty state", async ({ page }) => {
  await page.goto("/?window=settings");
  await page.getByPlaceholder(SEARCH).fill("zzzqx");
  await expect(page.getByText(/No settings match/)).toBeVisible();
});
