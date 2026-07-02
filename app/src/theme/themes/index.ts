// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the theme catalog — the single source of truth for Termixion's themes (vmark's
// post-theme-unification shape, origin/main src/theme/themes/index.ts @ d7e70e3f). Adding a
// theme: (1) add `./<name>.ts` exporting a `ThemeTokens` value, (2) append it to the `themes`
// map below. `ThemeId` and `THEME_IDS` are derived from the map, so neither union nor list can
// drift from the registered set. Declaration order is the issue's display order (trmx-53):
// White, Paper, Mint, Sepia, Night, Solarized.
import type { ThemeTokens } from "../tokens";
import { white } from "./white";
import { paper } from "./paper";
import { mint } from "./mint";
import { sepia } from "./sepia";
import { night } from "./night";
import { solarized } from "./solarized";

export const themes = {
  white,
  paper,
  mint,
  sepia,
  night,
  solarized,
} satisfies Record<string, ThemeTokens>;

/** Available theme identifiers — derived from the catalog so the union can never drift. */
export type ThemeId = keyof typeof themes;

/** The catalog's ids in display order (object insertion order = declaration order above). */
export const THEME_IDS = Object.keys(themes) as ThemeId[];

/** Runtime guard for untrusted input (persisted values, event payloads). */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(themes, value);
}

/** Display label for a theme id (trmx-53 D6: derived, not a separate table). */
export function themeLabel(id: ThemeId): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
