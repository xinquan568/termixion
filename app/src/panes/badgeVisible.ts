// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-90 (sub-task F): the pure visibility predicate for a pane's translucent badge overlay. A badge
// is a large corner watermark (iTerm2-style); in a very narrow pane it would collapse into an
// unreadable smear over the glyphs it is meant to sit behind, so below a small cell-width floor we
// suppress it entirely. Kept as a standalone PURE function (no React, no DOM) so the threshold is
// unit-testable headless and the overlay component (BadgeOverlay.tsx) / App stay thin consumers.

/**
 * The minimum pane width, in CELLS, at which a badge is drawn. Below this the pane is too narrow for
 * the large watermark to read, so the badge is hidden (the label persists in state — only its
 * rendering is suppressed). A coarse floor: a badge is identity chrome, not load-bearing content.
 */
export const MIN_BADGE_CELLS = 6;

/**
 * Whether a pane should render its badge overlay right now. False when the pane carries NO badge, or
 * when it is narrower than {@link MIN_BADGE_CELLS} cells (a sliver pane suppresses the watermark).
 * `cellsWide` is the pane's current column count (the terminal's `cols`); a non-finite / non-positive
 * reading is treated as too-narrow (hidden) — defensive, never throws.
 */
export function badgeVisible(cellsWide: number, hasBadge: boolean): boolean {
  if (!hasBadge) return false;
  if (!Number.isFinite(cellsWide)) return false;
  return cellsWide >= MIN_BADGE_CELLS;
}
