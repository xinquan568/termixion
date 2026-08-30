// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: the exit-flash / progress-bar colour helpers. They resolve a THEME, so they sit at L1
// with theme/ — not in ipc/ (L0), which may not import theme.

import { withAlpha } from "./colorMath";
import { resolveTheme } from "./registry";

// trmx-99: the alpha over the theme's semantic-error tint for the exit-code FLASH — faint enough to
// sit quietly at a pane's top edge, strong enough to read. (trmx-160: the BUSY line is no longer a
// theme tint — it is the iTerm2 progress-bar clone, a theme-independent green keyed only on the mode.)
export const ACTIVITY_LINE_ALPHA = 0.8;

/** trmx-99: the exit-code flash color — `color.semantic.error` at {@link ACTIVITY_LINE_ALPHA}. */
export function activityErrorColorFor(themeId: string): string {
  return withAlpha(resolveTheme(themeId).color.semantic.error, ACTIVITY_LINE_ALPHA);
}

/** trmx-160: the active theme's mode — selects the progress bar's track color (black/white) + period. */
export function activityIsDarkFor(themeId: string): boolean {
  return resolveTheme(themeId).isDark;
}
