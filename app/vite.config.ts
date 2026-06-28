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
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
