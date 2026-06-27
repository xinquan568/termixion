// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import { defineConfig } from "vite";
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
});
