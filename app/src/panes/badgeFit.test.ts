// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-149 (test-first): the badge FIT-TO-BOX model, ported EXACTLY from iTerm2. The font size is
// the largest integer point size whose rendered label fits a 2D box with INDEPENDENT constraints —
// width ≤ 0.5 × pane width AND height ≤ 0.2 × pane height (iTermAdvancedSettingsModel.m:794-795,
// badgeMaxWidthFraction / badgeMaxHeightFraction) — found by iTerm2's integer binary search
// (iTermBadgeLabel.m:143-181 idealPointSize, min 4 / max 100 per iTermBadgeLabel.m:28-31). The
// search is measurement-agnostic: a `BadgeMeasure` seam is injected, so these tests drive it with a
// DETERMINISTIC fake (width = widest-line chars × fontPx × 0.6, height = lines × fontPx × 1.05) and
// pin hand-traced convergence values. The REAL canvas measurer (makeCanvasBadgeMeasure) is covered
// via a stubbed 2d context — and pinned to return null under jsdom (no canvas package), which is
// exactly the fallback seam BadgeOverlay leans on.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BADGE_FONT_FAMILY,
  FALLBACK_FONT_PX,
  fitBadgeFontPx,
  makeCanvasBadgeMeasure,
  type BadgeMeasure,
} from "./badgeFit";

// The deterministic fake: a monospace-ish model. Width tracks the WIDEST line (the canvas measurer
// takes the max line width); height mirrors the .tx-badge line-height (1.05 × fontPx per line).
const fakeMeasure: BadgeMeasure = (text, fontPx) => {
  const lines = text.split("\n");
  const widest = Math.max(...lines.map((line) => line.length));
  return { width: widest * fontPx * 0.6, height: lines.length * fontPx * 1.05 };
};

describe("fitBadgeFontPx (trmx-149 — iTerm2 idealPointSize parity)", () => {
  it("is HEIGHT-bound on a wide, short pane — and the result is maximal under both constraints", () => {
    // maxW = 5000 (never binds), maxH = 20 → height 1.05f must stay under 20 → f = 19 (19.95 < 20;
    // 20 would give 21 > 20). Hand-traced through the iTerm2 loop: 52→28→16→22→19→20→19.
    const fit = fitBadgeFontPx("ab", 10000, 100, fakeMeasure);
    expect(fit).toBe(19);
    const at = fakeMeasure("ab", fit);
    expect(at.width).toBeLessThanOrEqual(0.5 * 10000);
    expect(at.height).toBeLessThanOrEqual(0.2 * 100);
    // Maximality: one point larger violates a constraint (here the height one).
    const above = fakeMeasure("ab", fit + 1);
    expect(above.width > 0.5 * 10000 || above.height > 0.2 * 100).toBe(true);
  });

  it("is WIDTH-bound on a narrow, tall pane — the constraints are independent", () => {
    // maxW = 100, maxH = 2000 (never binds) → width 6f must stay under 100 → f = 16 (96 < 100;
    // 17 would give 102 > 100). Hand-traced: 52→28→16→22→19→17→16.
    const fit = fitBadgeFontPx("abcdefghij", 200, 10000, fakeMeasure);
    expect(fit).toBe(16);
    const at = fakeMeasure("abcdefghij", fit);
    expect(at.width).toBeLessThanOrEqual(0.5 * 200);
    expect(at.height).toBeLessThanOrEqual(0.2 * 10000);
    const above = fakeMeasure("abcdefghij", fit + 1);
    expect(above.width > 0.5 * 200 || above.height > 0.2 * 10000).toBe(true);
  });

  it("gives a longer label a smaller-or-equal size than a shorter one (same pane)", () => {
    const short = fitBadgeFontPx("ab", 300, 10000, fakeMeasure);
    const long = fitBadgeFontPx("abcdefgh", 300, 10000, fakeMeasure);
    expect(long).toBeLessThanOrEqual(short);
  });

  it("never exceeds the iTerm2 point-size ceiling on a huge pane (midpoint converges at 99)", () => {
    // iTermBadgeLabel.m:28-31: minimumPointSize 4, maximumPointSize 100. The integer midpoint loop
    // never probes the ceiling itself — with min→99, max=100 the midpoint is (99+100)/2 = 99 (int
    // truncation), so an unconstrained box converges at 99. Exact parity, pinned.
    const fit = fitBadgeFontPx("ab", 1_000_000, 1_000_000, fakeMeasure);
    expect(fit).toBe(99);
    expect(fit).toBeLessThanOrEqual(100);
  });

  it("never drops below the iTerm2 point-size floor of 4 on a tiny pane", () => {
    // Every probed size overflows the 2×2px box → max collapses onto min: 52→28→16→10→7→5→4.
    expect(fitBadgeFontPx("ab", 10, 10, fakeMeasure)).toBe(4);
  });

  it("falls back to 28 for an empty label or degenerate pane geometry", () => {
    expect(FALLBACK_FONT_PX).toBe(28);
    expect(fitBadgeFontPx("", 800, 600, fakeMeasure)).toBe(FALLBACK_FONT_PX);
    expect(fitBadgeFontPx("x", 0, 600, fakeMeasure)).toBe(FALLBACK_FONT_PX);
    expect(fitBadgeFontPx("x", 800, 0, fakeMeasure)).toBe(FALLBACK_FONT_PX);
    expect(fitBadgeFontPx("x", -100, 600, fakeMeasure)).toBe(FALLBACK_FONT_PX);
    expect(fitBadgeFontPx("x", Number.NaN, 600, fakeMeasure)).toBe(FALLBACK_FONT_PX);
    expect(fitBadgeFontPx("x", 800, Number.POSITIVE_INFINITY, fakeMeasure)).toBe(FALLBACK_FONT_PX);
  });

  it("converges on the hand-computed spot value for a typical pane", () => {
    // "db" in a 400×200 pane: maxW = 200, maxH = 40. Width 1.2f never binds; height 1.05f < 40 →
    // f = 38 (39.9 < 40; 39 gives 40.95 > 40). Hand-traced: 52→28→40→34→37→38→39→38.
    expect(fitBadgeFontPx("db", 400, 200, fakeMeasure)).toBe(38);
  });
});

describe("makeCanvasBadgeMeasure (trmx-149 — the real measurer)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when a 2d context is unavailable (jsdom — the fallback seam)", () => {
    // jsdom without the canvas package: getContext("2d") is null → no measurer, callers fall back.
    expect(makeCanvasBadgeMeasure()).toBeNull();
  });

  /** Stub jsdom's null getContext with a recording fake 2d context (width = 10px per char). */
  function stubContext() {
    const measured: string[] = [];
    const ctx = {
      font: "",
      measureText(s: string) {
        measured.push(s);
        return { width: s.length * 10 };
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    return { ctx, measured };
  }

  it("measures with bold Helvetica at the probe size (the .tx-badge font, iTerm2's badgeFont)", () => {
    const { ctx } = stubContext();
    const measure = makeCanvasBadgeMeasure();
    expect(measure).not.toBeNull();
    const size = measure!("hello", 20);
    expect(ctx.font).toBe(`bold 20px ${BADGE_FONT_FAMILY}`);
    expect(size.width).toBe(50); // 5 chars × 10px
    expect(size.height).toBeCloseTo(21); // 1 line × 20 × 1.05 (the .tx-badge line-height)
  });

  it("takes the WIDEST line's width and stacks line heights for a multi-line label", () => {
    stubContext();
    const measure = makeCanvasBadgeMeasure()!;
    const size = measure("hi\nworld!", 20);
    expect(size.width).toBe(60); // max("hi" → 20, "world!" → 60)
    expect(size.height).toBeCloseTo(42); // 2 lines × 20 × 1.05
  });

  it("only the first 2 lines drive the measure (the CSS 2-line clamp)", () => {
    const { measured } = stubContext();
    const measure = makeCanvasBadgeMeasure()!;
    const fiveLines = measure("a\nbb\nc\nd\ne", 20);
    const twoLines = measure("a\nbb", 20);
    expect(fiveLines).toEqual(twoLines);
    expect(fiveLines.width).toBe(20); // max("a" → 10, "bb" → 20); lines 3-5 never measured
    expect(fiveLines.height).toBeCloseTo(42); // clamped to 2 lines
    expect(measured).toEqual(["a", "bb", "a", "bb"]);
  });
});
