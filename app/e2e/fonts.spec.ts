// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-204: bundled-font coverage at the two surfaces the dev-server harness can observe (no
// Tauri backend — persistence/cross-window apply is unit-covered in settingsStore/fontSettings).
// Terminal surface: the DEFAULT face actually loads (document.fonts.check proves the woff2
// parsed) and boot() completed through the font gate. Settings surface: the Font Family dropdown
// (five bundled + System default + Custom…), the custom free-text reveal, and the ligature note.
import { test, expect } from "@playwright/test";

const DEFAULT_FAMILY = "SauceCodePro Nerd Font Mono";

test("the bundled default face loads for real on the terminal surface", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".xterm")).toBeAttached();

  // The @font-face woff2 fetched, parsed, and is available — the authoritative in-browser proof
  // (a wrong path or family-name drift makes this false while computed styles would still lie).
  await expect
    .poll(() => page.evaluate((f) => document.fonts.check(`12px "${f}"`), DEFAULT_FAMILY))
    .toBe(true);
  await expect
    .poll(() => page.evaluate((f) => document.fonts.check(`bold 12px "${f}"`), DEFAULT_FAMILY))
    .toBe(true);
});

test("the Font Family dropdown offers the five bundled families + System default + Custom…", async ({
  page,
}) => {
  await page.goto("/?window=settings");
  const select = page.getByRole("combobox", { name: "Font Family" });
  await expect(select).toBeVisible();
  const labels = await select.locator("option").allTextContents();
  expect(labels).toEqual([
    "SauceCodePro Nerd Font Mono",
    "JetBrainsMono Nerd Font Mono",
    "MesloLGS NF",
    "Hack Nerd Font Mono",
    "FiraCode Nerd Font Mono",
    "System default",
    "Custom…",
  ]);
  // Fresh profile: the default entry is selected and no custom field is shown.
  await expect(select).toHaveValue(DEFAULT_FAMILY);
  await expect(page.getByRole("textbox", { name: "Font Family" })).toHaveCount(0);
});

test("selecting a bundled family sticks; Custom… reveals the free-text field; System default hides it", async ({
  page,
}) => {
  await page.goto("/?window=settings");
  const select = page.getByRole("combobox", { name: "Font Family" });

  await select.selectOption("MesloLGS NF");
  await expect(select).toHaveValue("MesloLGS NF");

  await select.selectOption("__custom__");
  const custom = page.getByRole("textbox", { name: "Font Family" });
  await expect(custom).toBeVisible();
  await custom.fill("Menlo, monospace");
  await custom.press("Enter");
  await expect(select).toHaveValue("__custom__");

  await select.selectOption("__system__");
  await expect(select).toHaveValue("__system__");
  await expect(page.getByRole("textbox", { name: "Font Family" })).toHaveCount(0);
});

test("the FiraCode entry surfaces the ligature caveat in the row helper text", async ({ page }) => {
  await page.goto("/?window=settings");
  const select = page.getByRole("combobox", { name: "Font Family" });
  await expect(page.getByText(/ligatures are not rendered/)).toHaveCount(0);
  await select.selectOption("FiraCode Nerd Font Mono");
  await expect(page.getByText(/ligatures are not rendered/)).toBeVisible();
});
