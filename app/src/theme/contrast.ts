// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-77: WCAG 2.x contrast math for the visual-baseline legibility gates
// (docs/design/visual-baseline.md §4). Pure module — no DOM/xterm/React imports (the same purity
// contract as tokens.ts) so the catalog gates run headless. Two consumers: the catalog-wide
// acceptance gates (themes.acceptance.test.ts) and the on-accent text derivation (txCssVars.ts).
// Alpha colors (selection tints, scrollbar triple) MUST go through compositeOver before any
// ratio is taken — a ratio against a non-composited rgba is meaningless.

/** Parse `#rgb` / `#rrggbb` into 0–255 channels. Throws on anything else. */
function hexChannels(color: string): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) throw new Error(`contrast: expected a hex color, got '${color}'`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Parse `rgba(r, g, b, a)` / `rgb(r, g, b)`. Throws on anything else. */
function rgbaChannels(color: string): [number, number, number, number] {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    color.trim(),
  );
  if (!m) throw new Error(`contrast: expected rgb()/rgba(), got '${color}'`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

/** WCAG relative luminance of an opaque hex color (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexChannels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque hex colors — 1 to 21, symmetric. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Resolve a possibly-translucent color against an opaque hex background: rgba is
 * alpha-composited channel-wise; opaque hex passes through unchanged. Returns `#rrggbb`.
 */
export function compositeOver(color: string, bg: string): string {
  if (color.trim().startsWith("#")) {
    hexChannels(color); // validate
    return color;
  }
  const [r, g, b, a] = rgbaChannels(color);
  const [br, bgc, bb] = hexChannels(bg);
  const mix = (c: number, bc: number) => Math.round(a * c + (1 - a) * bc);
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(mix(r, br))}${to2(mix(g, bgc))}${to2(mix(b, bb))}`;
}

/**
 * Pick the candidate with the highest contrast against `bg` (first wins ties — stable). Used to
 * derive readable text for accent/semantic control surfaces per theme (--tx-on-*).
 */
export function pickReadableOn(bg: string, candidates: readonly string[]): string {
  if (candidates.length === 0) throw new Error("contrast: pickReadableOn needs candidates");
  let best = candidates[0];
  let bestRatio = contrastRatio(best, bg);
  for (const candidate of candidates.slice(1)) {
    const ratio = contrastRatio(candidate, bg);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }
  return best;
}
