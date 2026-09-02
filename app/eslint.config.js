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
// The LEVEL MAP is the single source of truth: every top-level directory under app/src, plus the
// root files, gets exactly one level. The forbidden matrix below is GENERATED from it — a
// hand-written matrix is how the first version of this gate shipped with seven zones missing a
// source row and one legal edge wrongly banned.
//
// Rule: a module may import from a STRICTLY LOWER level, or from its own level. Peer imports are
// allowed on purpose — `commands -> scripts` and `chrome -> tabs` are legitimate, and forbidding
// them would ban the whole feature layer from talking to itself. What is banned is importing UP,
// which is what creates a cycle.
const LEVELS = {
  // L0 — leaves. Import nothing but each other and node_modules.
  assets: 0, ipc: 0, keys: 0, ui: 0, test: 0,
  // L1 — primitives over the transport.
  panes: 1, scripts: 1, smoke: 1, theme: 1,
  // L2 — the settings store: a primitive that terminal/, update/ and startup/ all read.
  store: 2,
  // L3 — feature runtime.
  startup: 3, tabs: 3, terminal: 3, update: 3,
  // L4 — composed surfaces.
  chrome: 4, commands: 4, conformance: 4, perf: 4, search: 4, settings: 4,
  // L5 — the control bridge drives commands.
  control: 5,
  // L6 — trmx-254: orchestration hooks extracted from App.tsx. Above every feature zone because it
  // composes them. PEER with the root files, deliberately: `__root__` is NOT shifted to 7, because
  // the directory-to-root ban below is unconditional over DIRS and already forbids app/ -> App.tsx.
  // What makes `app` constrained at all is simply BEING in this map; a zone absent from it is free.
  app: 6,
  // L6 — app/src/*.tsx entry points (App.tsx, main.tsx, surface.ts). Expressed as a glob, since
  // they are files rather than a directory.
  __root__: 6,
};

const DIRS = Object.keys(LEVELS).filter((z) => z !== "__root__");

/** Every (from, to) pair where `from` sits strictly BELOW `to` — i.e. an upward import. */
const ZONES = DIRS.flatMap((from) =>
  DIRS.filter((to) => LEVELS[from] < LEVELS[to]).map((to) => [from, to]),
);

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
          zones: [
            ...ZONES.map(([from, to]) => ({
              target: `./src/${from}`,
              from: `./src/${to}`,
              message: `${from}/ (L${LEVELS[from]}) may not import ${to}/ (L${LEVELS[to]}) — imports point DOWN. See the LEVELS map in eslint.config.js (trmx-247).`,
            })),
            // The root files are L6, so nothing may import them. Expressed as a glob because they
            // are files, not a directory — the omission that let `ipc -> ../surface` through and
            // could have recreated the root<->ipc cycle this rule exists to prevent.
            ...DIRS.map((from) => ({
              target: `./src/${from}`,
              from: "./src/*.ts?(x)",
              message: `${from}/ may not import an app/src root file (L6) — imports point DOWN. See the LEVELS map in eslint.config.js (trmx-247).`,
            })),
          ],
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
  {
    // trmx-252: public/ holds VERBATIM-copied browser assets, not bundled source — Vite ships them
    // untransformed, which is exactly why the CSP collector lives there (a classic script that runs
    // before the module graph). They are plain scripts and one is a worker, so they need the browser
    // and worker globals rather than the app's module environment. Still linted: they are real code.
    files: ["public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { window: "readonly", document: "readonly", self: "readonly" },
    },
  },
);
