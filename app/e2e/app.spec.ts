// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// D-3: component-level coverage of the webview boot. The live PTY needs the Tauri runtime (absent in
// the plain dev server), so this verifies the surface renders; the live PTY round-trip is the packaged
// `--smoke` (the authoritative gate).
import { test, expect } from "@playwright/test";

test("the terminal webview boots and renders", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Termixion" })).toBeVisible();

  // The xterm.js terminal surface mounts into the page.
  await expect(page.locator(".xterm")).toBeAttached();

  // No Tauri backend in the dev webview, so the handshake stays "connecting…".
  await expect(page.getByTestId("core-version")).toHaveText("connecting…");
});
