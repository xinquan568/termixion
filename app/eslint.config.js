// SPDX-License-Identifier: ISC
// ESLint flat config (A-3) for the Termixion frontend (TS + React).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "playwright-report", "test-results"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
  {
    // Config + E2E files run in Node (Playwright/Vite configs, Playwright runner).
    files: ["*.config.ts", "e2e/**/*.ts"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
);
