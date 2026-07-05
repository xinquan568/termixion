// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (I): e2e for the user-theme picker's UI surface. The Playwright harness runs against the
// plain `pnpm dev` server (no Tauri backend), so the FILE-backed flows — dropping a theme file,
// Duplicate writing to disk, live hot reload — cannot be exercised here (they need the real fs and
// are covered by the unit/integration suites with a fake backend + the packaged-app checklist in
// the PR's Test plan). What this spec pins is that the widened picker (trmx-89 D/4b) DEGRADES
// GRACEFULLY without a backend: the six built-ins still render and stay selectable, the new
// affordances (Open themes folder, Duplicate per built-in, the docs hint) are present, and no user
// themes appear (the registry hydrate no-ops without a runtime) — the app never crashes.
import { test, expect } from "@playwright/test";

test("Appearance picker: built-ins still render + the user-theme affordances are present (trmx-89)", async ({
  page,
}) => {
  await page.goto("/?window=settings&section=appearance");

  // The widening (ThemeId -> string, listThemes()) must not regress the built-in row: still exactly
  // the six built-ins, in order, all selectable radios (user themes need the backend, absent here).
  const swatches = page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio");
  await expect(swatches).toHaveCount(6);
  await expect(swatches).toHaveText(["White", "Paper", "Mint", "Sepia", "Night", "Solarized"]);

  // The new user-theme affordances render even with no backend:
  // - "Open themes folder" button (clicking it is a no-op without a runtime — the opener rejects
  //   and is swallowed; we assert presence + that a click does not crash the page).
  const openFolder = page.getByRole("button", { name: "Open themes folder" });
  await expect(openFolder).toBeVisible();

  // - a Duplicate affordance on each built-in swatch.
  await expect(page.getByRole("button", { name: /^Duplicate / })).toHaveCount(6);

  // - the file-format docs hint links docs/themes.md.
  const hint = page.getByRole("link", { name: "Learn the theme file format" });
  await expect(hint).toHaveAttribute("href", /docs\/themes\.md$/);

  // Graceful degradation: clicking Open-folder (opener rejects, no runtime) does not break the page —
  // the built-in row is still intact and interactive afterwards.
  await openFolder.click();
  await expect(swatches).toHaveCount(6);
  await page.getByRole("radio", { name: "Night" }).click();
  await expect(page.locator(".tx-settings")).toHaveCSS("background-color", "rgb(35, 38, 43)");
});
