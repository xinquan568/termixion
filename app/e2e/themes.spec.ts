// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (I): e2e for the user-theme picker's UI surface. The Playwright harness runs against the
// plain `pnpm dev` server (no Tauri backend), so the FILE-backed flows — dropping a theme file,
// Duplicate writing to disk, live hot reload — cannot be exercised here (they need the real fs and
// are covered by the unit/integration suites with a fake backend + the packaged-app checklist in
// the PR's Test plan). What this spec pins is that the widened picker (trmx-89 D/4b) DEGRADES
// GRACEFULLY without a backend: the six built-ins still render and stay selectable, the new
// affordances (Open themes folder, the trmx-171 right-click Duplicate menu, the docs hint) are
// present, and no user themes appear (the registry hydrate no-ops without a runtime) — never crashes.
import { test, expect } from "@playwright/test";

test("Appearance picker: built-ins still render + the user-theme affordances are present (trmx-89)", async ({
  page,
}) => {
  await page.goto("/?window=settings&section=appearance");

  // The widening (ThemeId -> string, listThemes()) must not regress the built-in row: still exactly
  // the twelve built-ins (trmx-53 six + trmx-201 six), in order, all selectable radios (user themes
  // need the backend, absent here).
  const swatches = page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio");
  await expect(swatches).toHaveCount(12);
  await expect(swatches).toHaveText(["White", "Paper", "Mint", "Sepia", "Night", "Solarized", "Catppuccin Mocha", "Catppuccin Latte", "Dracula", "Gruvbox", "Nord", "Tokyo Night"]);

  // The new user-theme affordances render even with no backend:
  // - "Open themes folder" button (clicking it is a no-op without a runtime — the opener rejects
  //   and is swallowed; we assert presence + that a click does not crash the page).
  const openFolder = page.getByRole("button", { name: "Open themes folder" });
  await expect(openFolder).toBeVisible();

  // - trmx-171: Duplicate is a right-click context menu now (no per-swatch button); right-clicking a
  //   built-in swatch opens the menu with a Duplicate item.
  await expect(page.getByRole("button", { name: /^Duplicate / })).toHaveCount(0);
  await page.getByRole("radio", { name: "Night", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Duplicate/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // - the file-format docs hint links docs/themes.md.
  const hint = page.getByRole("link", { name: "Learn the theme file format" });
  await expect(hint).toHaveAttribute("href", /docs\/themes\.md$/);

  // Graceful degradation: clicking Open-folder (opener rejects, no runtime) does not break the page —
  // the built-in row is still intact and interactive afterwards.
  await openFolder.click();
  await expect(swatches).toHaveCount(12);
  await page.getByRole("radio", { name: "Night", exact: true }).click();
  await expect(page.locator(".tx-settings")).toHaveCSS("background-color", "rgb(0, 0, 0)");
});
