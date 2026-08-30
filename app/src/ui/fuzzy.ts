// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-93 (FR-5): a small, dependency-free fuzzy matcher — a case-insensitive subsequence match
// with word-boundary and consecutive-run bonuses. Written to be SHARED with the FR-9 command
// palette (#94), so it takes a plain key function and stays pure (no React, no DOM). Unit-tested.

/** True when the character at `index` in `text` begins a "word": start-of-string, or preceded by a
 * separator (`/`, `-`, `_`, space, `.`), or a lower→UPPER camelCase transition. */
function isWordBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  const prev = text[index - 1];
  if (prev === "/" || prev === "-" || prev === "_" || prev === " " || prev === ".") return true;
  const here = text[index];
  return here !== here.toLowerCase() && prev === prev.toLowerCase();
}

/**
 * Score `candidate` against `query`. Returns `null` when `query` is not a subsequence of
 * `candidate` (case-insensitive); otherwise a number where HIGHER is a better match. An empty query
 * matches everything with a neutral score of 0. Bonuses: +3 for a match at a word boundary, +2 for
 * a match immediately after the previous one (a consecutive run), and a small penalty for extra
 * unmatched length so shorter candidates edge out longer ones on a tie.
 */
export function fuzzyMatch(query: string, candidate: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let score = 0;
  let cursor = 0;
  let prevMatch = -2;
  for (const ch of q) {
    let found = -1;
    for (let k = cursor; k < c.length; k++) {
      if (c[k] === ch) {
        found = k;
        break;
      }
    }
    if (found === -1) return null;
    score += 1;
    if (found === prevMatch + 1) score += 2;
    if (isWordBoundary(candidate, found)) score += 3;
    prevMatch = found;
    cursor = found + 1;
  }
  return score - (c.length - q.length) * 0.01;
}

/**
 * Keep the items whose `keyFn` value fuzzy-matches `query`, sorted best-match first. An empty query
 * returns every item in its ORIGINAL order (the picker's unfiltered list). Ties keep their original
 * relative order (stable), so a folders-first input stays folders-first among equal scores.
 */
export function fuzzyFilter<T>(query: string, items: readonly T[], keyFn: (item: T) => string): T[] {
  if (query === "") return [...items];
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const score = fuzzyMatch(query, keyFn(item));
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.map((s) => s.item);
}
