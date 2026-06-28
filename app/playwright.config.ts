// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// D-3: component-level E2E against the Vite dev-server webview (NOT the packaged macOS app). The
// authoritative end-to-end gate is the built-app `--smoke` (Tauri has no macOS WebDriver — Risk R-3);
// this Playwright suite gives component coverage of the webview boot.
import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: !isCI,
    timeout: 60_000,
  },
});
