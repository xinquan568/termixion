// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches a subsequence case-insensitively and rejects a non-subsequence", () => {
    expect(fuzzyMatch("px", "proj-x.sh")).not.toBeNull();
    expect(fuzzyMatch("PX", "proj-x.sh")).not.toBeNull();
    expect(fuzzyMatch("xp", "proj-x.sh")).toBeNull(); // wrong order
    expect(fuzzyMatch("zzz", "proj-x.sh")).toBeNull();
  });

  it("an empty query matches everything with a neutral score", () => {
    expect(fuzzyMatch("", "anything")).toBe(0);
  });

  it("scores a word-boundary/prefix match higher than a mid-word one", () => {
    // 'p' at the start of "proj" (boundary) beats 'p' buried inside "top".
    const boundary = fuzzyMatch("p", "proj.sh")!;
    const midword = fuzzyMatch("p", "top.sh")!;
    expect(boundary).toBeGreaterThan(midword);
  });

  it("rewards a consecutive run over a scattered (non-boundary) match", () => {
    // Both are mid-word (no separators, so no boundary bonus muddies it): "abc" appears as a
    // consecutive run in the first, but scattered between filler letters in the second.
    const run = fuzzyMatch("abc", "xabc")!;
    const scattered = fuzzyMatch("abc", "xaxbxc")!;
    expect(run).toBeGreaterThan(scattered);
  });
});

describe("fuzzyFilter", () => {
  const items = ["work/proj-x.sh", "work/proj-y.sh", "deploy.sh", "tools/build.sh"];

  it("drops non-matches and ranks best-first", () => {
    const out = fuzzyFilter("proj", items, (s) => s);
    expect(out).toEqual(["work/proj-x.sh", "work/proj-y.sh"]);
  });

  it("an empty query returns every item in original order", () => {
    expect(fuzzyFilter("", items, (s) => s)).toEqual(items);
  });

  it("is stable for equal scores (original relative order kept)", () => {
    // Both proj-x and proj-y score identically for "proj"; x stays before y (input order).
    const out = fuzzyFilter("proj", items, (s) => s);
    expect(out.indexOf("work/proj-x.sh")).toBeLessThan(out.indexOf("work/proj-y.sh"));
  });

  it("matches on the leaf via a custom key function", () => {
    const objs = [{ rel: "a/deploy.sh" }, { rel: "b/other.sh" }];
    expect(fuzzyFilter("deploy", objs, (o) => o.rel)).toEqual([{ rel: "a/deploy.sh" }]);
  });
});
