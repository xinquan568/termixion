// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-232 (T1, test-first): the settings-search primitives — the query normalizer and the pure
// row predicate. The predicate is the ONE matching rule the whole feature rides on (rows, groups,
// panels all call it), so its contract is pinned here: empty query matches everything; matching is
// case-insensitive substring over label + description + keywords; absent description/keywords
// never break a match on the other fields.
import { describe, expect, it } from "vitest";
import { matchesSettingsQuery, normalizeSettingsQuery } from "./settingsSearch";

describe("normalizeSettingsQuery", () => {
  it("trims and lowercases", () => {
    expect(normalizeSettingsQuery("  ScrollBack ")).toBe("scrollback");
  });

  it("maps whitespace-only input to the empty query", () => {
    expect(normalizeSettingsQuery("   ")).toBe("");
  });
});

describe("matchesSettingsQuery", () => {
  it("matches everything on the empty query (the not-searching state)", () => {
    expect(matchesSettingsQuery("", "Cursor Style")).toBe(true);
    expect(matchesSettingsQuery("", "Cursor Style", "Shape of the terminal cursor")).toBe(true);
  });

  it("matches the label, case-insensitively", () => {
    expect(matchesSettingsQuery("cursor", "Cursor Style")).toBe(true);
    expect(matchesSettingsQuery("CURSOR", "Cursor Style")).toBe(false); // callers pass a NORMALIZED query
    expect(matchesSettingsQuery("blink", "Cursor Style")).toBe(false);
  });

  it("matches the description when the label misses", () => {
    expect(matchesSettingsQuery("shape", "Cursor Style", "Shape of the terminal cursor")).toBe(
      true,
    );
  });

  it("matches keywords when label and description miss", () => {
    expect(
      matchesSettingsQuery("clipboard", "Copy on Select", "Automatically copy", ["clipboard"]),
    ).toBe(true);
    expect(matchesSettingsQuery("history", "Scrollback", undefined, ["history", "buffer"])).toBe(
      true,
    );
  });

  it("misses cleanly on a row with no description and no keywords", () => {
    expect(matchesSettingsQuery("orientation", "Position")).toBe(false);
  });
});
