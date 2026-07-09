// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-81 (FR-2.2, test-first): the pure tab-bar layout engine. App keeps its JSX order fixed
// (hosts first, strip LAST) and gets the bar onto the requested window edge purely by flex
// direction: bottom → column, top → column-reverse, right → row, left → row-reverse. The strip's
// own orientation follows the edge: horizontal along top/bottom, vertical along left/right.
// trmx-82 (FR-2.3, test-first): labelOrientationFor gates the side-rail label orientation — the
// setting may only take effect on a VERTICAL rail (left/right); top/bottom bars force horizontal.
// railGeometryFor is the SINGLE geometry source for VERTICAL-LABEL mode (TabStrip writes the
// tokens as CSS custom properties on its root there; index.css consumes only the bare variables);
// its non-vertical-label returns are the CSS status quo, kept as reference data for these tests.
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

// trmx-82: the rail-geometry tokens. Only the vertical rail WITH vertical labels gets the
// narrow-rail tokens (the ONE combination consumed at runtime — TabStrip writes them, the
// labels-vertical CSS reads them); everything else is the trmx-81 status quo (the 28px strip/row
// height and the 16px close square), kept as REFERENCE data for totality — index.css hardcodes
// those numbers itself and no rule consumes them as vars.
// trmx-163: `railWidthPx` is RETIRED — the rail width is now the CSS-owned `--tab-bar-thickness`
// (28px, equal to the horizontal strip height by construction), no longer a barLayout token; the
// strip/row reference height drops 34→28 to match.
// trmx-151 adds hintHeaderPx — the upright ⌘N chip's fixed row (trmx-163: at the BOTTOM of the
// trailing group, below the rotated label): 0 outside vertical-label mode (horizontal hints sit
// inline, no chip row), 20 in it; the min/max
// heights grow by exactly that 20 (60→80, 180→200) so the LABEL's own budget is preserved.
describe("railGeometryFor (trmx-82)", () => {
  const STATUS_QUO = {
    tabMaxHeightPx: 28,
    tabMinHeightPx: 28,
    closeHitTargetMinPx: 16,
    hintHeaderPx: 0,
    // trmx-165: the reserved top row that hosts the close × in vertical-label mode — 0 elsewhere
    // (the horizontal strip / horizontal-label rail overlay the close without a reserved gutter).
    closeHeaderPx: 0,
  };

  it("vertical rail + vertical labels → the narrow rail with tall-tab tokens", () => {
    expect(railGeometryFor("vertical", "vertical")).toEqual({
      tabMaxHeightPx: 200,
      tabMinHeightPx: 80,
      closeHitTargetMinPx: 24,
      hintHeaderPx: 20,
      // trmx-165: a 24px reserved top gutter (≥ the close hit target) so the × never overlaps the
      // rotated title; the title centres in the row below it.
      closeHeaderPx: 24,
    });
  });

  it("vertical rail + horizontal labels → the trmx-81 status quo (180px rail)", () => {
    expect(railGeometryFor("vertical", "horizontal")).toEqual(STATUS_QUO);
  });

  it("horizontal strips return the status-quo tokens regardless of the label orientation", () => {
    // The height/close tokens are reference data on a horizontal strip — never written; the rail
    // width is no longer a token at all (trmx-163: CSS-owned --tab-bar-thickness).
    expect(railGeometryFor("horizontal", "horizontal")).toEqual(STATUS_QUO);
    expect(railGeometryFor("horizontal", "vertical")).toEqual(STATUS_QUO);
  });

  it("junk casts fall back to the status-quo tokens (total over inputs)", () => {
    expect(railGeometryFor("diagonal" as "vertical", "vertical")).toEqual(STATUS_QUO);
    expect(railGeometryFor("vertical", "diagonal" as "vertical")).toEqual(STATUS_QUO);
  });
});
