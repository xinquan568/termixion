// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-205: the Shell selector on the settings surface, scoped to what the dev-server harness
// observes (no Tauri backend, so shells_list rejects and the dropdown DEGRADES to
// System default + Custom path… — itself specified behavior). Spawn precedence and discovery
// are Rust-unit + real-PTY covered.
import { test, expect } from "@playwright/test";

test("the Shell row renders with the degraded no-backend options, defaulting to System default", async ({
  page,
}) => {
  await page.goto("/?window=settings");
  const select = page.getByRole("combobox", { name: "Shell" });
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("__system__");
  const labels = await select.locator("option").allTextContents();
  expect(labels).toEqual(["System default", "Custom path…"]);
  await expect(page.getByText("Applies to new sessions", { exact: false })).toBeVisible();
});

test("Custom path… reveals the free-text field and System default hides it again", async ({
  page,
}) => {
  await page.goto("/?window=settings");
  const select = page.getByRole("combobox", { name: "Shell" });
  await select.selectOption("__custom__");
  const custom = page.getByRole("textbox", { name: "Shell" });
  await expect(custom).toBeVisible();
  await expect(custom).toHaveAttribute("placeholder", "/bin/zsh");
  await custom.fill("/opt/homebrew/bin/fish");
  await custom.press("Enter");
  await expect(select).toHaveValue("__custom__");

  await select.selectOption("__system__");
  await expect(page.getByRole("textbox", { name: "Shell" })).toHaveCount(0);
});
