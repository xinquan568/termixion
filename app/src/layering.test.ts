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
import { describe, expect, it } from "vitest";

import config from "../eslint.config.js";

type Zone = { target: string; from: string };

/** The flat-config block that carries the layering rule. */
const rule = (() => {
  for (const block of config as Array<Record<string, unknown>>) {
    const rules = block?.rules as Record<string, unknown> | undefined;
    const entry = rules?.["import-x/no-restricted-paths"];
    if (Array.isArray(entry)) return entry[1] as { zones: Zone[] };
  }
  throw new Error("import-x/no-restricted-paths is not configured");
})();

const zones = rule.zones;
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
});
