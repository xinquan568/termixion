// SPDX-License-Identifier: ISC
// ESLint flat config (A-3) for the Termixion frontend (TS + React).
import js from "@eslint/js";
import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

// trmx-247: the frontend layering gate — the counterpart to scripts/check-core-seam.sh on the Rust
// side. Directories are ordered into ZONES; an import may only point at a zone at or below its own.
//
// Two mechanism notes, both learned the hard way:
//
//  * `import-x/no-cycle` is deliberately NOT used. The FILE-level import graph has zero
//    strongly-connected components, so no-cycle reports clean — while the DIRECTORY graph was one
//    component spanning 14 zones before this PR. Zones are the only mechanism that sees that.
//
//  * `no-restricted-paths` silently SKIPS imports it cannot resolve, so the resolver below is
//    load-bearing, not decoration: without it the rule is present, correct-looking, and never fires.
//    The PR that added this ran a deliberate violation per zone to prove otherwise. We use
//    import-x's own node resolver with the TS extensions rather than
//    eslint-import-resolver-typescript, which drags a native `unrs-resolver` build this repo's
//    supply-chain policy blocks — fewer dependencies for the same resolution.
//
// eslint-plugin-import (not -x) is unusable here: its newest release (2.32.0) peers eslint ^2..^9
// and this repo runs 10.x.
const ZONES = [
  // [zone, may NOT import from these]
  ["ipc", ["panes", "terminal", "tabs", "commands", "scripts", "settings", "theme", "store", "startup", "update", "chrome", "control", "search", "perf", "conformance", "smoke", "keys", "ui"]],
  ["keys", ["panes", "terminal", "tabs", "commands", "scripts", "settings", "theme", "store", "startup", "update", "chrome", "control", "search", "ipc", "ui"]],
  ["ui", ["panes", "terminal", "tabs", "commands", "scripts", "settings", "theme", "store", "startup", "update", "chrome", "control", "search"]],
  ["panes", ["terminal", "tabs", "commands", "scripts", "settings", "theme", "store", "startup", "update", "chrome", "control", "search"]],
  ["scripts", ["terminal", "tabs", "commands", "settings", "theme", "store", "startup", "update", "chrome", "control", "search"]],
  ["theme", ["terminal", "tabs", "commands", "scripts", "settings", "store", "startup", "update", "chrome", "control", "search", "panes"]],
  ["store", ["terminal", "tabs", "commands", "scripts", "settings", "startup", "update", "chrome", "control", "search", "panes"]],
  ["startup", ["tabs", "commands", "settings", "chrome", "control", "search"]],
  ["tabs", ["commands", "settings", "chrome", "control", "search"]],
  ["terminal", ["tabs", "commands", "settings", "chrome", "control", "search"]],
  ["update", ["tabs", "commands", "settings", "chrome", "control", "search"]],
  ["commands", ["settings", "control"]],
  ["chrome", ["settings", "control", "commands"]],
  ["settings", ["control"]],
];

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
    plugins: { "import-x": importX },
    settings: {
      // Load-bearing: no-restricted-paths skips what it cannot resolve.
      "import-x/resolver-next": [
        importX.createNodeResolver({ extensions: [".ts", ".tsx", ".js", ".jsx"] }),
      ],
    },
    rules: {
      // Test files are IN SCOPE on purpose: exempting them would leave the boundary unenforced
      // exactly where it eroded (ipc/useBackend.test.tsx reached into terminal/ before trmx-247).
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: ZONES.flatMap(([from, forbidden]) =>
            forbidden.map((target) => ({
              target: `./src/${from}`,
              from: `./src/${target}`,
              message: `${from}/ may not import ${target}/ — see the zone table in eslint.config.js (trmx-247).`,
            })),
          ),
        },
      ],
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
