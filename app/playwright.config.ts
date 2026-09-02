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
  // trmx-302: no retries anywhere. `retries: 1` was masking flakes rather than tolerating them —
  // at a 2% per-run rate, two consecutive failures is ~0.05%, so a real flake would essentially
  // never be seen. A retry is only safe when someone looks at what it absorbed, and nobody was.
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    // MUST change with `retries` above, in the same commit. `on-first-retry` records only a retry,
    // so with zero retries it emits NOTHING — setting retries to 0 alone would have made CI
    // failures strictly harder to diagnose, which is the opposite of the intent.
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: !isCI,
    timeout: 60_000,
  },
});
