// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-77 (test-first): the WCAG contrast module behind the visual-baseline legibility gates
// (docs/design/visual-baseline.md §4). Known-value pins come from the WCAG 2.x definition:
// relative luminance over linearized sRGB, ratio = (Lhi + 0.05) / (Llo + 0.05). compositeOver
// resolves rgba tokens (selection tints, scrollbar triple) against an opaque background before
// any ratio is taken — a ratio against a non-composited alpha color is meaningless.
import { describe, expect, it } from "vitest";
import { compositeOver, contrastRatio, pickReadableOn, relativeLuminance } from "./contrast";

describe("relativeLuminance", () => {
  it("pins the WCAG anchor values", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBe(1);
    expect(relativeLuminance("#ff0000")).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance("#00ff00")).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance("#0000ff")).toBeCloseTo(0.0722, 4);
  });

  it("normalizes 3-digit hex and case", () => {
    expect(relativeLuminance("#fff")).toBe(1);
    expect(relativeLuminance("#FFFFFF")).toBe(1);
  });

  it("rejects junk input loudly (a silent 0 would fake a 21:1 ratio)", () => {
    expect(() => relativeLuminance("nope")).toThrow();
    expect(() => relativeLuminance("")).toThrow();
    expect(() => relativeLuminance("rgba(0,0,0,0.5)")).toThrow();
  });
});

describe("contrastRatio", () => {
  it("pins black-on-white at the WCAG maximum", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
  });

  it("pins the classic 4.5:1 boundary gray", () => {
    // #767676 on white is the canonical just-passes-AA pair.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 1);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#58a6ff", "#23262b")).toBe(contrastRatio("#23262b", "#58a6ff"));
  });
});

describe("compositeOver", () => {
  it("composites an rgba tint over an opaque background (White selection over white bg)", () => {
    expect(compositeOver("rgba(0,102,204,0.25)", "#ffffff")).toBe("#bfd9f2");
  });

  it("tolerates rgba whitespace variants (the catalog writes 'rgba(90, 168, 255, 0.22)')", () => {
    expect(compositeOver("rgba(90, 168, 255, 0.22)", "#23262b")).toBe(
      compositeOver("rgba(90,168,255,0.22)", "#23262b"),
    );
  });

  it("passes opaque colors through", () => {
    expect(compositeOver("#123456", "#ffffff")).toBe("#123456");
    expect(compositeOver("rgba(10, 20, 30, 1)", "#ffffff")).toBe("#0a141e");
  });

  it("rejects junk input loudly", () => {
    expect(() => compositeOver("hsl(0, 0%, 0%)", "#ffffff")).toThrow();
  });
});

describe("pickReadableOn", () => {
  it("picks the max-contrast candidate (Night accent needs dark text, not white)", () => {
    expect(pickReadableOn("#58a6ff", ["#fff", "#23262b"])).toBe("#23262b");
    expect(pickReadableOn("#0066cc", ["#fff", "#1a1a1a"])).toBe("#fff");
  });

  it("keeps the first candidate on a tie (stable pick)", () => {
    expect(pickReadableOn("#0066cc", ["#fff", "#ffffff"])).toBe("#fff");
  });

  it("rejects an empty candidate list", () => {
    expect(() => pickReadableOn("#0066cc", [])).toThrow();
  });
});
