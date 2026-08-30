// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-247: the badge font stack, moved out of `panes/` into the leaf `ui/` zone so `theme/`'s
// font-chokepoint test can read it without importing a feature directory. `ui/` holds shared
// presentation primitives and imports nothing above itself.

/**
 * The badge font stack — Helvetica first (iTerm2's default badgeFont, rendered bold per
 * badgeFontIsBold), with metric-compatible fallbacks for non-mac platforms. The SINGLE source for
 * both the canvas measurer's font string and the `.tx-badge` CSS rule (index.css mirrors this
 * token list verbatim — the CSS contract test in BadgeOverlay.test.tsx pins the mirror), so the
 * measured font is always the painted font.
 */
export const BADGE_FONT_FAMILY = 'Helvetica, "Helvetica Neue", Arial, "Liberation Sans", sans-serif';
