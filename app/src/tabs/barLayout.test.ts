// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-81 (FR-2.2, test-first): the pure tab-bar layout engine. App keeps its JSX order fixed
// (hosts first, strip LAST) and gets the bar onto the requested window edge purely by flex
// direction: bottom → column, top → column-reverse, right → row, left → row-reverse. The strip's
// own orientation follows the edge: horizontal along top/bottom, vertical along left/right.
import { describe, it, expect } from "vitest";
import { barLayoutFor } from "./barLayout";
import type { TabBarPosition } from "../settings/settingsStore";

describe("barLayoutFor", () => {
  it("bottom → column + horizontal (the LAST flex child lands on the bottom edge)", () => {
    expect(barLayoutFor("bottom")).toEqual({
      flexDirection: "column",
      orientation: "horizontal",
    });
  });

  it("top → column-reverse + horizontal (same JSX order, reversed axis)", () => {
    expect(barLayoutFor("top")).toEqual({
      flexDirection: "column-reverse",
      orientation: "horizontal",
    });
  });

  it("right → row + vertical", () => {
    expect(barLayoutFor("right")).toEqual({
      flexDirection: "row",
      orientation: "vertical",
    });
  });

  it("left → row-reverse + vertical", () => {
    expect(barLayoutFor("left")).toEqual({
      flexDirection: "row-reverse",
      orientation: "vertical",
    });
  });

  it("a junk cast falls back to the bottom layout (mirrors the registry's parse fallback)", () => {
    expect(barLayoutFor("middle" as TabBarPosition)).toEqual({
      flexDirection: "column",
      orientation: "horizontal",
    });
  });
});
