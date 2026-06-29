// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-41 (test-first): the pure Kitty-style scrollbar geometry/visibility core. These tests pin the
// behavior the issue asks for — visible ONLY while scrolled back (Kitty's default `scrolled` policy),
// thumb height ∝ the visible fraction (with a one-cell minimum), thumb position ∝ scroll, and the hover
// affordance — with no xterm/DOM dependency (measurements are passed in, so it runs headless).
import { describe, it, expect } from "vitest";
import {
  computeScrollbar,
  createScrollbarOverlay,
  applyScrollbar,
  KITTY_SCROLLBAR,
  type ScrollbarInput,
} from "./scrollbar";

// A scrolled-back, normal-buffer baseline: 24 visible rows, 100 lines of scrollback, viewport halfway.
const base: ScrollbarInput = {
  rows: 24,
  cols: 80,
  viewportY: 50,
  baseY: 100,
  length: 124,
  isAltBuffer: false,
  hostWidthPx: 800,
  hostHeightPx: 480,
  hovering: false,
};

describe("computeScrollbar — visibility (Kitty `scrolled` policy)", () => {
  it("is hidden at the live bottom (viewportY === baseY)", () => {
    expect(computeScrollbar({ ...base, viewportY: 100 })).toEqual({ visible: false });
  });

  it("is hidden when there is no scrollback (baseY === 0)", () => {
    expect(computeScrollbar({ ...base, viewportY: 0, baseY: 0, length: 24 })).toEqual({
      visible: false,
    });
  });

  it("is hidden on the alternate buffer even if scrolled back", () => {
    expect(computeScrollbar({ ...base, isAltBuffer: true })).toEqual({ visible: false });
  });

  it("is shown when scrolled back in the normal buffer with history", () => {
    const g = computeScrollbar(base);
    expect(g.visible).toBe(true);
  });
});

describe("computeScrollbar — thumb geometry", () => {
  it("thumb height encodes the visible fraction (rows / length)", () => {
    const g = computeScrollbar(base);
    if (!g.visible) throw new Error("expected visible");
    // height fraction ≈ rows/length when the minimum does not bind.
    expect(g.thumbHeightPx / g.trackHeightPx).toBeCloseTo(base.rows / base.length, 5);
  });

  it("clamps the thumb to a minimum of one cell when scrollback is enormous", () => {
    // rows=2 over a huge buffer: the raw visible fraction is tiny, so the 1-cell minimum binds.
    const tiny: ScrollbarInput = {
      ...base,
      rows: 2,
      hostHeightPx: 40, // cellHeight = 40/2 = 20px
      viewportY: 1,
      baseY: 100000,
      length: 100002,
    };
    const g = computeScrollbar(tiny);
    if (!g.visible) throw new Error("expected visible");
    const cellHeight = tiny.hostHeightPx / tiny.rows; // 20px
    const rawFraction = tiny.rows / tiny.length; // ~2e-5
    // The thumb is at least ~one cell tall, far larger than the raw visible fraction would give.
    expect(g.thumbHeightPx).toBeGreaterThanOrEqual(cellHeight - 1);
    expect(g.thumbHeightPx).toBeGreaterThan(rawFraction * g.trackHeightPx);
  });

  it("places the thumb at the track top when scrolled to the oldest line (viewportY === 0)", () => {
    const g = computeScrollbar({ ...base, viewportY: 0 });
    if (!g.visible) throw new Error("expected visible");
    expect(g.thumbTopPx).toBeCloseTo(g.trackTopPx, 5);
  });

  it("moves the thumb down monotonically as the viewport approaches the live bottom", () => {
    const near = computeScrollbar({ ...base, viewportY: 10 });
    const far = computeScrollbar({ ...base, viewportY: 50 });
    if (!near.visible || !far.visible) throw new Error("expected visible");
    expect(far.thumbTopPx).toBeGreaterThan(near.thumbTopPx);
  });

  it("positions the bar on the right with the configured gap and rounded radius", () => {
    const g = computeScrollbar(base);
    if (!g.visible) throw new Error("expected visible");
    const cellWidth = base.hostWidthPx / base.cols; // 10px
    expect(g.gapPx).toBeCloseTo(KITTY_SCROLLBAR.gap * cellWidth, 5);
    expect(g.radiusPx).toBeCloseTo(KITTY_SCROLLBAR.radius * cellWidth, 5);
    expect(g.trackTopPx).toBeCloseTo(g.gapPx, 5);
  });
});

describe("computeScrollbar — hover affordance", () => {
  it("widens the handle and fades in a faint track on hover", () => {
    const idle = computeScrollbar(base);
    const hover = computeScrollbar({ ...base, hovering: true });
    if (!idle.visible || !hover.visible) throw new Error("expected visible");
    // Handle width grows from 0.5 to 1.0 cell-widths.
    expect(hover.widthPx).toBeGreaterThan(idle.widthPx);
    expect(hover.widthPx / idle.widthPx).toBeCloseTo(
      KITTY_SCROLLBAR.hoverWidth / KITTY_SCROLLBAR.width,
      5,
    );
    // Track is invisible at rest, faintly visible on hover; handle opacity is constant.
    expect(idle.trackOpacity).toBe(KITTY_SCROLLBAR.trackOpacity);
    expect(hover.trackOpacity).toBe(KITTY_SCROLLBAR.trackHoverOpacity);
    expect(idle.handleOpacity).toBe(KITTY_SCROLLBAR.handleOpacity);
  });
});

describe("computeScrollbar — degenerate inputs never produce NaN", () => {
  it("stays finite when cols/rows/length are zero", () => {
    const g = computeScrollbar({
      ...base,
      cols: 0,
      rows: 0,
      length: 0,
      hostWidthPx: 0,
      hostHeightPx: 0,
    });
    if (!g.visible) throw new Error("expected visible (still scrolled back)");
    for (const v of [
      g.widthPx,
      g.gapPx,
      g.radiusPx,
      g.trackTopPx,
      g.trackHeightPx,
      g.thumbTopPx,
      g.thumbHeightPx,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("applyScrollbar — DOM writes", () => {
  it("hides the overlay container when not visible", () => {
    const overlay = createScrollbarOverlay(document);
    applyScrollbar(overlay, { visible: false }, "#ffffff");
    expect(overlay.container.style.display).toBe("none");
  });

  it("writes the right offset, geometry, color and opacity when visible", () => {
    const overlay = createScrollbarOverlay(document);
    const g = computeScrollbar(base);
    if (!g.visible) throw new Error("expected visible");
    applyScrollbar(overlay, g, "#abcdef");

    expect(overlay.container.style.display).toBe("");
    // The Kitty horizontal gap is applied as a right offset on both track and thumb.
    expect(overlay.thumb.style.right).toBe(`${g.gapPx}px`);
    expect(overlay.track.style.right).toBe(`${g.gapPx}px`);
    // Thumb geometry + style.
    expect(overlay.thumb.style.top).toBe(`${g.thumbTopPx}px`);
    expect(overlay.thumb.style.height).toBe(`${g.thumbHeightPx}px`);
    expect(overlay.thumb.style.width).toBe(`${g.widthPx}px`);
    expect(overlay.thumb.style.opacity).toBe(String(g.handleOpacity));
    // Color is the supplied foreground.
    expect(overlay.thumb.style.background).toBe("rgb(171, 205, 239)"); // #abcdef normalized by jsdom
  });
});
