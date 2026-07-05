// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89: pure color math for user-theme derivation (deriveTheme). These helpers exist so a user's
// ThemeSpec — which may omit every optional color — can be expanded into a complete ThemeTokens with
// values that hang together (tinted backgrounds, mixed text tiers, alpha overlays). No DOM / xterm /
// React imports (the same purity contract as tokens.ts) so the derivation is unit-testable headless.
// Robustness rule: these NEVER throw. A non-hex input falls back to returning the input unchanged, so
// a malformed user color degrades to a passthrough rather than crashing the whole theme pipeline
// (contrast.ts throws by design for its gates; this module must not, because it runs on user data).

/** 0–255 RGB channels. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** #rgb / #rgba / #rrggbb / #rrggbbaa — the four hex forms we accept (alpha, when present, is dropped). */
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Parse a hex color into 0–255 channels, ignoring any alpha channel (#rgba / #rrggbbaa). Returns
 * `null` on anything that is not one of the four accepted hex forms — callers treat `null` as
 * "leave the input alone" so the module never throws on user input.
 */
export function hexToRgb(hex: string): Rgb | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  const short = h.length === 3 || h.length === 4; // #rgb / #rgba → expand each nibble
  const r = short ? h[0] + h[0] : h.slice(0, 2);
  const g = short ? h[1] + h[1] : h.slice(2, 4);
  const b = short ? h[2] + h[2] : h.slice(4, 6);
  return { r: parseInt(r, 16), g: parseInt(g, 16), b: parseInt(b, 16) };
}

/** Clamp to a whole 0–255 channel. */
const clampChannel = (n: number): number => Math.min(255, Math.max(0, Math.round(n)));

/** Serialize 0–255 channels back to `#rrggbb` (channels are clamped + rounded). */
export function rgbToHex({ r, g, b }: Rgb): string {
  const to2 = (n: number): string => clampChannel(n).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/**
 * Linear channel-wise blend of two hex colors: `t = 0` → `a`, `t = 1` → `b`. Used to pull the text
 * tiers toward the background and to derive the border. If either input is non-hex, returns `a`
 * unchanged (never throws).
 */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return a;
  const lerp = (x: number, y: number): number => x * (1 - t) + y * t;
  return rgbToHex({ r: lerp(ca.r, cb.r), g: lerp(ca.g, cb.g), b: lerp(ca.b, cb.b) });
}

/**
 * Shade a hex color a signed percentage of the way toward white (positive `signedPct`, lighten) or
 * black (negative, darken) — used to raise the sunken/elevated background tiers off `bg.primary`
 * (lighten on dark themes, darken on light). Non-hex input returns unchanged (never throws).
 */
export function shade(hex: string, signedPct: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const amount = Math.abs(signedPct) / 100;
  const target = signedPct >= 0 ? 255 : 0;
  const adjust = (c: number): number => c + (target - c) * amount;
  return rgbToHex({ r: adjust(rgb.r), g: adjust(rgb.g), b: adjust(rgb.b) });
}

/**
 * Wrap a hex color as an `rgba(r, g, b, a)` string with the given alpha — the overlay form used for
 * accent tints, selection, semantic error backgrounds, and the scrollbar triple. Non-hex input
 * returns unchanged (never throws), so an already-`rgba(...)` value passes straight through.
 */
export function withAlpha(color: string, a: number): string {
  const rgb = hexToRgb(color);
  if (!rgb) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
}
