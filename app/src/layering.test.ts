// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-247: the layering gate's own self-test — the frontend counterpart to
// scripts/check-*.test.sh on the Rust side.
//
// Why this exists: the first version of this gate had a HAND-WRITTEN forbidden matrix. It shipped
// with seven directories missing a source row entirely (assets, test, smoke, conformance, perf,
// search, control) and no way to express the app/src root files — so `ipc/` importing `../surface`
// passed, which is exactly the root<->ipc cycle the rule is supposed to prevent. It also banned one
// LEGAL downward edge. Spot-checking a handful of violations by hand had "proved" the gate worked.
//
// So the matrix is now GENERATED from the LEVELS map, and this test walks EVERY ordered pair of
// zones and asserts the rule agrees with the level ordering in both directions. A missing row or a
// stray ban fails here rather than years later.
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

type Zone = { target: string; from: string };

// Read the EFFECTIVE config through ESLint rather than importing eslint.config.js directly. Two
// reasons: the config is untyped JS (a direct import fails the production `tsc` build), and this
// asserts against what ESLint actually resolves for a real file — which is what enforces the rule.
let zones: Zone[] = [];
beforeAll(async () => {
  const resolved = await new ESLint().calculateConfigForFile("src/ipc/backend.ts");
  const entry = (resolved.rules as Record<string, unknown>)["import-x/no-restricted-paths"];
  if (!Array.isArray(entry)) throw new Error("import-x/no-restricted-paths is not configured");
  zones = (entry[1] as { zones: Zone[] }).zones;
});
const dirOf = (p: string) => p.replace("./src/", "");
/** Is `from -> to` banned by the configured zones? */
const banned = (from: string, to: string) =>
  zones.some((z) => dirOf(z.target) === from && dirOf(z.from) === to);

// Mirrors the LEVELS map in eslint.config.js. Duplicated deliberately: if the two ever disagree,
// this test fails, which is the point — it is a second opinion, not a re-export.
const LEVELS: Record<string, number> = {
  assets: 0, ipc: 0, keys: 0, ui: 0, test: 0,
  panes: 1, scripts: 1, smoke: 1, theme: 1,
  store: 2,
  startup: 3, tabs: 3, terminal: 3, update: 3,
  chrome: 4, commands: 4, conformance: 4, perf: 4, search: 4, settings: 4,
  control: 5,
  app: 6, // trmx-254: orchestration hooks. Peer with the root files by design — see eslint.config.js.
};
const DIRS = Object.keys(LEVELS);

describe("frontend layering gate (trmx-247)", () => {
  it("bans every upward import and permits every downward or peer one", () => {
    const wrong: string[] = [];
    for (const from of DIRS) {
      for (const to of DIRS) {
        if (from === to) continue;
        const shouldBan = LEVELS[from] < LEVELS[to];
        if (banned(from, to) !== shouldBan) {
          wrong.push(
            `${from}(L${LEVELS[from]}) -> ${to}(L${LEVELS[to]}): ` +
              `${shouldBan ? "should be BANNED but is allowed" : "should be ALLOWED but is banned"}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("covers every directory as an import SOURCE", () => {
    // The original hand-written table simply omitted seven of these.
    const sources = new Set(zones.map((z) => dirOf(z.target)));
    expect(DIRS.filter((d) => !sources.has(d))).toEqual([]);
  });

  it("bans importing an app/src ROOT file from every directory", () => {
    // The hole that let `ipc/ -> ../surface` through — a directory-vs-file expression problem, not
    // a missing level.
    const rootBans = new Set(
      zones.filter((z) => z.from === "./src/*.ts?(x)").map((z) => dirOf(z.target)),
    );
    expect(DIRS.filter((d) => !rootBans.has(d))).toEqual([]);
  });

  // The three cases above check the CONFIGURATION. These run ESLint for real, because a correct
  // matrix is still worthless if the rule does not fire on the file kinds we care about — and
  // "test files are in scope" was the whole reason ipc/useBackend.test.tsx could reach into
  // terminal/ before trmx-247.
  const lintAs = async (filePath: string, code: string) => {
    // vitest runs with cwd = app/, where eslint.config.js lives, so the default lookup finds it.
    const eslint = new ESLint();
    const [result] = await eslint.lintText(code, { filePath });
    return result.messages.filter((m) => m.ruleId === "import-x/no-restricted-paths");
  };

  it("fires inside a TEST file, not just production source", async () => {
    const found = await lintAs(
      "src/ipc/probe.test.ts",
      'import { activityTransition } from "../panes/activityLine";\nvoid activityTransition;\n',
    );
    expect(found).toHaveLength(1);
  });

  it("fires on a TYPE-ONLY import", async () => {
    const found = await lintAs(
      "src/ipc/probe.ts",
      'import type { TerminalHandle } from "../terminal/mountTerminal";\nexport type P = TerminalHandle;\n',
    );
    expect(found).toHaveLength(1);
  });

  it("does NOT fire on a legal downward import", async () => {
    const found = await lintAs(
      "src/store/probe.ts",
      'import { fuzzyFilter } from "../ui/fuzzy";\nvoid fuzzyFilter;\n',
    );
    expect(found).toHaveLength(0);
  });

  // trmx-254: the new orchestration zone. `app/` sits at L6, PEER with the root files, so the
  // level comparison never bans app -> root. What does is the unconditional directory-to-root rule,
  // which applies to `app` purely because `app` is in the LEVELS map. Delete the `app: 6` entry and
  // this probe stops firing — that is the mutation that proves the gate is not decorative.
  it("bans app/ from importing an app/src ROOT file (trmx-254)", async () => {
    const found = await lintAs(
      "src/app/probe.ts",
      'import { App } from "../App";\nvoid App;\n',
    );
    expect(found).toHaveLength(1);
  });

  it("permits app/ importing DOWN into a feature zone (trmx-254)", async () => {
    const found = await lintAs(
      "src/app/probe.ts",
      'import type { PaneId } from "../panes/layoutTree";\nexport type P = PaneId;\n',
    );
    expect(found).toHaveLength(0);
  });

  it("bans a feature zone from importing UP into app/ (trmx-254)", async () => {
    const found = await lintAs(
      "src/terminal/probe.ts",
      'import type { PaneRuntime } from "../app/paneRuntime";\nexport type P = PaneRuntime;\n',
    );
    expect(found).toHaveLength(1);
  });
});
