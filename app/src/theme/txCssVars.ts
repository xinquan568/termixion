// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the theme → settings-window delivery. `txCssVars` is the ONE role table mapping
// catalog tokens onto the `--tx-*` custom properties settings.css consumes (bg tiers: primary =
// content, secondary = sunken sidebar, tertiary = elevated controls — vmark's tier semantics).
// `applyTxTheme` writes them as inline style on `document.documentElement`: an inline style on
// the html element beats the `:root` stylesheet fallback, and settings.css declares `--tx-*`
// under `:root` ONLY (guarded by test), so the runtime value inherits unimpeded into the
// `.tx-settings` tree (plan D4 — the cascade-winning single write target, valid pre-mount and
// live). The body background is painted alongside so the window chrome never flashes.
import { pickReadableOn } from "./contrast";
import { isThemeId, themes, type ThemeId } from "./themes";
import type { ThemeTokens } from "./tokens";

/** The settings-surface CSS variables derived from a theme — the single role table. */
export function txCssVars(theme: ThemeTokens): Record<string, string> {
  // trmx-77 (G5): text on the accent/semantic control surfaces is DERIVED, not hardcoded —
  // white text fails on Night's light-blue accent (#58a6ff ≈ 2.53:1). Per surface, pick the more
  // readable of white / the theme's own background (docs/design/visual-baseline.md §4).
  const onSurface = (surface: string) => pickReadableOn(surface, ["#fff", theme.color.bg.primary]);
  return {
    "--tx-bg": theme.color.bg.primary,
    "--tx-bg-elev": theme.color.bg.tertiary,
    "--tx-bg-sunken": theme.color.bg.secondary,
    "--tx-text": theme.color.text.primary,
    "--tx-text-2": theme.color.text.secondary,
    "--tx-text-3": theme.color.text.tertiary,
    "--tx-border": theme.color.border,
    // trmx-87 (FR-3.6): the multi-pane divider/border colors (active outlines the focused pane).
    "--tx-pane-active-border": theme.terminal.pane.activeBorder,
    "--tx-pane-inactive-border": theme.terminal.pane.inactiveBorder,
    "--tx-primary": theme.color.accent.primary,
    "--tx-success": theme.color.semantic.success,
    "--tx-error": theme.color.semantic.error,
    "--tx-on-accent": onSurface(theme.color.accent.primary),
    "--tx-on-success": onSurface(theme.color.semantic.success),
    "--tx-on-error": onSurface(theme.color.semantic.error),
  };
}

/**
 * Apply a theme to the settings surface: every `--tx-*` var onto `documentElement` (inline, so
 * it wins over the `:root` fallback) plus the body background. Idempotent — safe to re-apply on
 * bus echoes. Junk ids fall back to White (defense-in-depth behind the registry's parse).
 */
export function applyTxTheme(id: ThemeId, doc: Document = document): void {
  const theme = isThemeId(id) ? themes[id] : themes.white;
  const root = doc.documentElement;
  for (const [name, value] of Object.entries(txCssVars(theme))) {
    root.style.setProperty(name, value);
  }
  doc.body.style.background = theme.color.bg.primary;
}
