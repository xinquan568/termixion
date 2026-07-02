// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the first-run theme derivation. The OS appearance is consulted exactly once — when no
// theme is persisted (fresh install, or after About → Reset all removes the key) — mapping
// dark → Night and light → White, and the result is then persisted by the settings registry.
// This supersedes trmx-44's LIVE OS-appearance following; after the first run the OS is never
// consulted again. Reuses iterm2Theme's defensive appearance reader (no matchMedia → dark, the
// historical Termixion look → Night). No settings-store import here (the store depends on this
// module, never the reverse — vmark's no-back-edge rule).
import { initialAppearanceFromWindow } from "../terminal/iterm2Theme";
import type { ThemeId } from "./themes";

/** The theme a fresh (or freshly-reset) install starts with, from the OS appearance. */
export function defaultThemeId(
  win?: Pick<Window, "matchMedia"> | undefined,
): ThemeId {
  return initialAppearanceFromWindow(win) === "dark" ? "night" : "white";
}
