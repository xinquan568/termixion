// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-247: the OS appearance reader, moved out of `terminal/iterm2Theme.ts` into `theme/` — it was
// the ONLY theme -> terminal import, and `theme/defaultTheme.ts` (its main consumer) now reads it as
// a same-directory neighbour. `terminal/` keeps the iTerm2 palette and re-imports these.

/** Light or dark, the only two appearances Termixion tracks. */
export type Appearance = "dark" | "light";

/** Map the OS `prefers-color-scheme: dark` boolean to an appearance. */
export function prefersDarkToMode(prefersDark: boolean): Appearance {
  return prefersDark ? "dark" : "light";
}

/**
 * Read the current system appearance from a window-like object. Defensive: if `matchMedia` is
 * unavailable (e.g. a non-DOM/headless context), default to dark — Termixion's historical look.
 */
export function initialAppearanceFromWindow(
  win: Pick<Window, "matchMedia"> | undefined = typeof window !== "undefined" ? window : undefined,
): Appearance {
  if (!win || typeof win.matchMedia !== "function") return "dark";
  return prefersDarkToMode(win.matchMedia("(prefers-color-scheme: dark)").matches);
}
