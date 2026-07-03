// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-75 (FR-2.4): the pure title model — no React, no reducer, just strings. A tab's rendered
// title is the EFFECTIVE title over four sources with fixed precedence:
//
//   manual (user rename) > osc (OSC 0/2 escape) > process (foreground hint) > fallback
//
// where a slot that is absent OR sanitizes to empty does not count. Sanitization (C0/C1 control
// strip, trim, 256-char cap) happens here and ONLY here, so the tabState reducer, the App wiring
// (T5), and the rename UI (T6) all share one definition of "a displayable title".

/**
 * The per-tab title sources, highest precedence first. The three optional slots are set/cleared
 * by the reducer's `setTitleSource`; `fallback` is always present (seeded "Shell" at openTab,
 * refreshed by attachSession) so `effectiveTitle` always has a last resort.
 */
export interface TitleSources {
  /** The user's explicit rename (FR-2.4) — outranks everything until cleared back to auto. */
  manual?: string;
  /** The program's OSC 0/2 title — cleared when the program resets it to empty. */
  osc?: string;
  /** The foreground-process hint from the 1 Hz poller — NEVER outranks manual/osc. */
  process?: string;
  /** The last-resort label; the reducer keeps this non-empty. */
  fallback: string;
}

/** Hard cap on a sanitized title's length, in code points (hostile OSC payloads can be huge). */
export const MAX_TITLE_LENGTH = 256;

// C0 (U+0000–U+001F), DEL (U+007F), and C1 (U+0080–U+009F): the ranges an OSC payload or a weird
// process name can smuggle in. NBSP (U+00A0) and above are legitimate title characters.
// eslint-disable-next-line no-control-regex -- stripping control characters is the whole point
const CONTROL_CHARS = /[\u{0}-\u{1f}\u{7f}-\u{9f}]/gu;

/**
 * Make a raw title displayable: strip C0/C1 controls (including \n/\t — a title is one line),
 * trim surrounding whitespace, cap at {@link MAX_TITLE_LENGTH}. The cap counts CODE POINTS so a
 * surrogate pair (emoji) is never torn in half; CJK and emoji pass through untouched. May return
 * "" — callers treat that as "this source does not count".
 */
export function sanitizeTitle(raw: string): string {
  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned; // UTF-16 length ≤ cap ⇒ code points ≤ cap
  return [...cleaned].slice(0, MAX_TITLE_LENGTH).join("");
}

/**
 * The one rendered title: the highest-precedence slot whose SANITIZED value is non-empty, else
 * the sanitized fallback (the reducer keeps `fallback` non-empty, so "" only escapes here for a
 * caller that supplied a junk fallback itself).
 */
export function effectiveTitle(sources: TitleSources): string {
  for (const candidate of [sources.manual, sources.osc, sources.process]) {
    if (candidate === undefined) continue;
    const clean = sanitizeTitle(candidate);
    if (clean !== "") return clean;
  }
  return sanitizeTitle(sources.fallback);
}
