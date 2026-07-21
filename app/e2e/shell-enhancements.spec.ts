// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-206: the Shell Enhancements toggles on the settings surface (dev-server scope: no Tauri
// backend, so effective_shell rejects and the rows render degraded-VISIBLE — itself specified).
// The spawn-side behavior (shim, guards, kill switch) is Rust-unit + real-PTY covered.
import { test, expect } from "@playwright/test";

test("the enhancement trio renders with defaults on; master-off disables the sub-toggles", async ({
  page,
}) => {
  await page.goto("/?window=settings");
  const master = page.getByRole("switch", { name: "Shell Enhancements" });
  const auto = page.getByRole("switch", { name: "Autosuggestions" });
  const highlight = page.getByRole("switch", { name: "Syntax Highlighting" });
  await expect(master).toBeVisible();
  await expect(master).toHaveAttribute("aria-checked", "true");
  await expect(auto).toBeEnabled();
  await expect(highlight).toBeEnabled();

  await master.click();
  await expect(master).toHaveAttribute("aria-checked", "false");
  await expect(auto).toBeDisabled();
  await expect(highlight).toBeDisabled();

  await master.click();
  await expect(auto).toBeEnabled();
});
