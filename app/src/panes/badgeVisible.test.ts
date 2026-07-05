// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-90 (sub-task F, test-first): the pure badge-visibility threshold. A badge shows only when it
// exists AND the pane is wide enough (>= MIN_BADGE_CELLS); no badge or a sliver pane hides it.
import { describe, it, expect } from "vitest";
import { badgeVisible, MIN_BADGE_CELLS } from "./badgeVisible";

describe("badgeVisible (trmx-90)", () => {
  it("is false when the pane has no badge, at any width", () => {
    expect(badgeVisible(200, false)).toBe(false);
    expect(badgeVisible(MIN_BADGE_CELLS, false)).toBe(false);
    expect(badgeVisible(0, false)).toBe(false);
  });

  it("is true when a badge exists and the pane is at least MIN_BADGE_CELLS wide", () => {
    expect(badgeVisible(MIN_BADGE_CELLS, true)).toBe(true);
    expect(badgeVisible(MIN_BADGE_CELLS + 1, true)).toBe(true);
    expect(badgeVisible(120, true)).toBe(true);
  });

  it("hides the badge in a pane narrower than the cell floor", () => {
    expect(badgeVisible(MIN_BADGE_CELLS - 1, true)).toBe(false);
    expect(badgeVisible(1, true)).toBe(false);
    expect(badgeVisible(0, true)).toBe(false);
  });

  it("pins the floor at 6 cells (the chosen ~6-cell threshold)", () => {
    expect(MIN_BADGE_CELLS).toBe(6);
    expect(badgeVisible(5, true)).toBe(false);
    expect(badgeVisible(6, true)).toBe(true);
  });

  it("treats a non-finite / negative width as too-narrow (hidden), never throws", () => {
    expect(badgeVisible(Number.NaN, true)).toBe(false);
    expect(badgeVisible(Number.POSITIVE_INFINITY, true)).toBe(false);
    expect(badgeVisible(-10, true)).toBe(false);
  });
});
