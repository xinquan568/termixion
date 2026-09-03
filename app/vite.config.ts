// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// A-1 skeleton. Vite dev server on 5173 (matches tauri.conf.json devUrl).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
  },
  // D-2: Vitest. jsdom for the DOM, jest-dom matchers + cleanup wired in the setup file. Tests
  // live next to the code they cover (src/**/*.test.tsx); they are never imported by the entry,
  // so they are excluded from the production bundle.
  test: {
    environment: "jsdom",
    // trmx-253 (M20): coverage measurement. The repo's near 1:1 source-to-test FILE parity was never
    // evidence of coverage — it counts files, not lines or branches.
    coverage: {
      provider: "v8",
      // Extension-qualified on purpose: a bare `src/**` also matches css/json/png/md and would put
      // non-code in the denominator.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.*",
        "src/**/*.d.ts",
        "src/test/**",
        // DELIBERATE, and recorded as a choice rather than an oversight: this removes
        // conformance/driver.ts — the file trmx-253 singles out — from the denominator, because
        // counting a test harness's own lines inflates the figure without informing anyone.
        // driver.ts still has its own direct test (conformance/driver.test.ts).
        "src/conformance/**",
        // trmx-253 (review finding 1) excluded main.tsx because it is NEVER EXECUTED by a test:
        // importing it under jsdom boots the real app, so its tests read its TEXT, and v8 emitted a
        // 0/0 entry for a file holding thirteen function constructs — boot and composition-root code
        // could grow entirely uncovered without moving any threshold.
        //
        // trmx-250 (L10) CLOSED THAT GAP: the boot path — the startup order, the composition root,
        // the launch gates, the mount, the global handlers and the fatal surface — now lives in
        // src/boot.tsx, which IS measured (boot.test.tsx executes it against a recorder). What is
        // left in main.tsx is wiring: the `realBootDeps` object of real implementations and one
        // `start` call, still unimportable under jsdom for the same reason, and pinned by the one
        // textual assertion in main.shim.test.ts. The exclusion stays for that file alone.
        "src/main.tsx",
      ],
      reporter: ["text-summary", "html", "lcov"],
      // trmx-253: a RATCHET, not a target — and deliberately not a percentage. A percentage floor
      // drifts as files are added or deleted, and a lines-only floor lets branch and function
      // coverage collapse while lines hold (branches trail lines by ~6 points here, which is
      // exactly the gap 1:1 source-to-test FILE parity concealed). Negative thresholds are Vitest's
      // MAXIMUM UNCOVERED COUNTS: these are the measured uncovered totals at the trmx-253 baseline,
      // so new uncovered code fails the build while refactors that delete covered code do not.
      // Lower them when coverage improves; raising one is a reviewed decision, not a convenience.
      //
      // BRANCHES has NO cushion (-433 = the measured value). The one-run variance affected only
      // statements, functions and lines; branches were identical across every run, so slack there
      // would be unexplained slack — and an undocumented three-branch allowance is exactly the kind
      // of quiet headroom a ratchet exists to prevent.
      //
      // The +1 on statements/functions/lines is MEASURED, not padding. Four of five baseline runs
      // reported 4937/2843/1260/4318 covered; one reported exactly one fewer statement, function
      // and line (branches unchanged), i.e. one small function went unexecuted in that run. Three
      // consecutive runs since have been byte-identical, so the variance is rare rather than
      // constant — but a floor set at the best observed value would have failed that run, and a
      // gate that fails one CI run in five is the flake trmx-302 spent a whole issue removing.
      // The source of the variance is UNIDENTIFIED; if it widens, this threshold reports it as a
      // failure rather than absorbing it silently.
      thresholds: {
        statements: -508,
        branches: -433,
        functions: -198,
        lines: -360,
      },
    },
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
