// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-81 (FR-2.2, test-first): the pure tab-bar layout engine. App keeps its JSX order fixed
// (hosts first, strip LAST) and gets the bar onto the requested window edge purely by flex
// direction: bottom → column, top → column-reverse, right → row, left → row-reverse. The strip's
// own orientation follows the edge: horizontal along top/bottom, vertical along left/right.
// trmx-82 (FR-2.3, test-first): labelOrientationFor gates the side-rail label orientation — the
// setting may only take effect on a VERTICAL rail (left/right); top/bottom bars force horizontal.
// railGeometryFor is the SINGLE geometry source for the rail tokens (App writes them as CSS
// custom properties; index.css consumes only the variables).
import { describe, it, expect } from "vitest";
import { barLayoutFor, labelOrientationFor, railGeometryFor } from "./barLayout";
import type { LabelOrientation, TabBarPosition } from "../settings/settingsStore";

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

// trmx-82 (FR-2.3): "vertical" labels ONLY on a vertical rail with the setting opted in — every
// other combination (any top/bottom bar, or the "horizontal" setting) is horizontal. Total over
// junk casts on either argument.
describe("labelOrientationFor (trmx-82)", () => {
  it("the full 4×2 position × setting table", () => {
    const table: Array<[TabBarPosition, LabelOrientation, "horizontal" | "vertical"]> = [
      ["top", "horizontal", "horizontal"],
      ["top", "vertical", "horizontal"], // a horizontal bar can never rotate its labels
      ["bottom", "horizontal", "horizontal"],
      ["bottom", "vertical", "horizontal"],
      ["left", "horizontal", "horizontal"], // the trmx-81 status quo: side rail, readable labels
      ["left", "vertical", "vertical"],
      ["right", "horizontal", "horizontal"],
      ["right", "vertical", "vertical"],
    ];
    for (const [position, setting, expected] of table) {
      expect(labelOrientationFor(position, setting), `${position} + ${setting}`).toBe(expected);
    }
  });

  it("a junk POSITION cast falls back to horizontal (the bottom-layout default)", () => {
    expect(labelOrientationFor("middle" as TabBarPosition, "vertical")).toBe("horizontal");
  });

  it("a junk SETTING cast falls back to horizontal (only the exact 'vertical' member rotates)", () => {
    expect(labelOrientationFor("left", "diagonal" as LabelOrientation)).toBe("horizontal");
    expect(labelOrientationFor("right", 7 as unknown as LabelOrientation)).toBe("horizontal");
  });
});

// trmx-82: the rail-geometry tokens — the SINGLE source both App's CSS custom properties and the
// tests measure against. Only the vertical rail WITH vertical labels gets the narrow-rail tokens;
// everything else is the trmx-81 status quo (railWidthPx 180; the 34px strip/row height and the
// 16px close square, kept as data — no rule outside vertical-label mode consumes them).
describe("railGeometryFor (trmx-82)", () => {
  const STATUS_QUO = {
    railWidthPx: 180,
    tabMaxHeightPx: 34,
    tabMinHeightPx: 34,
    closeHitTargetMinPx: 16,
  };

  it("vertical rail + vertical labels → the narrow rail (44) with tall-tab tokens", () => {
    expect(railGeometryFor("vertical", "vertical")).toEqual({
      railWidthPx: 44,
      tabMaxHeightPx: 180,
      tabMinHeightPx: 60,
      closeHitTargetMinPx: 24,
    });
  });

  it("vertical rail + horizontal labels → the trmx-81 status quo (180px rail)", () => {
    expect(railGeometryFor("vertical", "horizontal")).toEqual(STATUS_QUO);
  });

  it("horizontal strips return the status-quo tokens regardless of the label orientation", () => {
    // railWidthPx is irrelevant on a horizontal strip — kept at 180 so the vars stay inert.
    expect(railGeometryFor("horizontal", "horizontal")).toEqual(STATUS_QUO);
    expect(railGeometryFor("horizontal", "vertical")).toEqual(STATUS_QUO);
  });

  it("junk casts fall back to the status-quo tokens (total over inputs)", () => {
    expect(railGeometryFor("diagonal" as "vertical", "vertical")).toEqual(STATUS_QUO);
    expect(railGeometryFor("vertical", "diagonal" as "vertical")).toEqual(STATUS_QUO);
  });
});
