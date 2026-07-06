// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-100 (FR-3.4, test-first): the five-zone drop hit-test.
import { describe, it, expect } from "vitest";
import { dropZone } from "./dropZone";
import type { Rect } from "./layoutTree";

const R: Rect = { x: 100, y: 50, width: 400, height: 300 }; // center (300, 200)
const at = (x: number, y: number) => dropZone(R, { x, y });

describe("dropZone", () => {
  it("the center square swaps", () => {
    expect(at(300, 200)).toBe("center");
    expect(at(320, 210)).toBe("center"); // still within the inner 30%
  });

  it("each edge region docks on that edge", () => {
    expect(at(120, 200)).toBe("left"); // far left, vertically centered
    expect(at(480, 200)).toBe("right"); // far right
    expect(at(300, 60)).toBe("top"); // top, horizontally centered
    expect(at(300, 340)).toBe("bottom"); // bottom
  });

  it("resolves a corner deterministically to the horizontal edge (|dx| >= |dy|)", () => {
    // top-left corner: dx and dy both negative; the >= tie-break picks horizontal → left
    expect(at(100, 50)).toBe("left");
    expect(at(500, 350)).toBe("right"); // bottom-right → right
  });

  it("clamps a pointer outside the rect and never throws on a zero-size rect", () => {
    expect(at(0, 0)).toBe("left"); // clamped to top-left → horizontal → left
    expect(dropZone({ x: 0, y: 0, width: 0, height: 0 }, { x: 5, y: 5 })).toBe("center");
  });
});
