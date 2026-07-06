// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-98 (FR-1.5, test-first): the pure find-bar state machine.
import { describe, expect, it } from "vitest";
import {
  findReducer,
  initialFindState,
  isValidRegex,
  isSearchable,
  countLabel,
  searchOptions,
  type FindState,
} from "./findState";

const base = (over: Partial<FindState> = {}): FindState => ({ ...initialFindState, ...over });

describe("findReducer — query & toggles", () => {
  it("setQuery stores the query", () => {
    expect(findReducer(base(), { type: "setQuery", query: "foo" }).query).toBe("foo");
  });
  it("toggleCase / toggleRegex flip their flags", () => {
    const a = findReducer(base(), { type: "toggleCase" });
    expect(a.caseSensitive).toBe(true);
    expect(findReducer(a, { type: "toggleRegex" }).regex).toBe(true);
  });
  it("reset returns the initial state", () => {
    const dirty = base({ query: "x", regex: true, index: 3, total: 5 });
    expect(findReducer(dirty, { type: "reset" })).toEqual(initialFindState);
  });
});

describe("findReducer — results & count", () => {
  it("setResults records index/total", () => {
    const s = findReducer(base({ query: "a" }), { type: "setResults", index: 2, total: 17 });
    expect(s).toMatchObject({ index: 2, total: 17 });
    expect(countLabel(s)).toBe("3/17"); // 1-based active
  });
  it("empty query → no label; a searchable query with no matches → 0/0", () => {
    expect(countLabel(base())).toBe(""); // empty query
    expect(countLabel(base({ query: "zzz", index: -1, total: 0 }))).toBe("0/0");
  });
});

describe("findReducer — invalid regex", () => {
  it("sets error, zeroes results, and stays 0/0; ignores stale setResults", () => {
    let s = findReducer(base({ regex: true }), { type: "setQuery", query: "(" }); // unbalanced
    expect(s.error).toBe(true);
    expect(s).toMatchObject({ index: -1, total: 0 });
    expect(isSearchable(s)).toBe(false);
    // a late addon result must not un-error the state
    s = findReducer(s, { type: "setResults", index: 0, total: 3 });
    expect(s.error).toBe(true);
    expect(countLabel(s)).toBe("0/0");
  });
  it("a valid regex clears the error; toggling regex off makes a '(' literal valid", () => {
    const bad = findReducer(base({ regex: true }), { type: "setQuery", query: "(" });
    expect(bad.error).toBe(true);
    const good = findReducer(bad, { type: "toggleRegex" }); // regex off → "(" is a plain literal
    expect(good.error).toBe(false);
    expect(isSearchable(good)).toBe(true);
  });
  it("isValidRegex distinguishes valid/invalid patterns", () => {
    expect(isValidRegex("^\\d+$")).toBe(true);
    expect(isValidRegex("(")).toBe(false);
  });
});

describe("searchOptions — maps state + theme colors to ISearchOptions", () => {
  it("carries regex/caseSensitive and both decoration colors (with required overview-ruler fields)", () => {
    const s = base({ regex: true, caseSensitive: true });
    const opts = searchOptions(s, { match: "#ffcc0055", activeMatch: "#ff8800aa" });
    expect(opts.regex).toBe(true);
    expect(opts.caseSensitive).toBe(true);
    expect(opts.decorations.matchBackground).toBe("#ffcc0055");
    expect(opts.decorations.activeMatchBackground).toBe("#ff8800aa");
    expect(opts.decorations.activeMatchColorOverviewRuler).toBe("#ff8800aa"); // required by the addon
  });
});
