// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-204: the bundled-font catalog — single source of truth for the five @font-face families
// shipped under app/public/fonts/ (declared in app/src/fonts.css). The CSS-facing `family` strings
// are OURS (declared by @font-face), deliberately independent of the archives' internal name
// tables (nerd-fonts v3 abbreviates some to "… NFM"). terminal.fontFamily stays a plain string:
// "" = the platform default stack, a catalog family = a bundled font, anything else = a custom
// user-provided stack passed through verbatim. Composition happens at the display chokepoint
// (fontSettings.resolveFontFamily → fontStackFor): a bundled family gets the platform stack
// appended so a failed face degrades gracefully instead of falling to the renderer's default.
import { ITERM2_FONT_FAMILY } from "./iterm2Theme";
import type { SettingsStore } from "../settings/settingsStore";

export interface BundledFont {
  /** Stable id = the asset directory under app/public/fonts/. */
  id: string;
  /** The exact CSS font-family name declared by fonts.css — also the persisted setting value. */
  family: string;
  /** The dropdown label. */
  label: string;
}

/** Catalog order = dropdown order (default first). */
export const BUNDLED_FONTS: readonly BundledFont[] = [
  { id: "sauce-code-pro", family: "SauceCodePro Nerd Font Mono", label: "SauceCodePro Nerd Font Mono" },
  { id: "jetbrains-mono", family: "JetBrainsMono Nerd Font Mono", label: "JetBrainsMono Nerd Font Mono" },
  { id: "meslo-lgs", family: "MesloLGS NF", label: "MesloLGS NF" },
  { id: "hack", family: "Hack Nerd Font Mono", label: "Hack Nerd Font Mono" },
  { id: "fira-code", family: "FiraCode Nerd Font Mono", label: "FiraCode Nerd Font Mono" },
];

/** trmx-204: the new out-of-the-box default (was "" = the platform stack before). */
export const DEFAULT_FONT_FAMILY = "SauceCodePro Nerd Font Mono";

export function isBundledFamily(value: string): boolean {
  return BUNDLED_FONTS.some((font) => font.family === value);
}

/**
 * The effective xterm fontFamily for a persisted setting value: "" (or whitespace) = the platform
 * default stack; a bundled family = that family quoted, platform stack appended as fallback; any
 * other value = the user's own stack, verbatim.
 */
export function fontStackFor(value: string): string {
  if (value.trim() === "") return ITERM2_FONT_FAMILY;
  if (isBundledFamily(value)) return `"${value}", ${ITERM2_FONT_FAMILY}`;
  return value;
}

/** The FontFaceSet surface we use — jsdom ships none, so every access is defensive. */
interface FontsLike {
  load(spec: string): Promise<unknown>;
}

function documentFonts(): FontsLike | undefined {
  const fonts = (globalThis.document as { fonts?: FontsLike } | undefined)?.fonts;
  return typeof fonts?.load === "function" ? fonts : undefined;
}

/** fonts.load can throw SYNCHRONOUSLY on a bad shorthand — fold that into the settled promise. */
function safeLoad(fonts: FontsLike, spec: string): Promise<unknown> {
  try {
    return Promise.resolve(fonts.load(spec));
  } catch {
    return Promise.resolve(undefined);
  }
}

/**
 * Best-effort load of a bundled family's regular + bold faces. NEVER throws and NEVER hangs:
 * a rejecting (or synchronously throwing) load resolves (the composed stack falls back), a stuck
 * load loses the timeout race. The 12px probe size is arbitrary — FontFaceSet.load keys on the
 * family, not the size.
 */
export async function ensureFontLoaded(family: string, timeoutMs = 2000): Promise<void> {
  const fonts = documentFonts();
  if (!fonts) return;
  const loads = Promise.allSettled([
    safeLoad(fonts, `12px "${family}"`),
    safeLoad(fonts, `bold 12px "${family}"`),
  ]);
  await Promise.race([loads, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

/**
 * The trmx-204 boot gate (pinned by main.order.test.ts): after settings hydration, make the
 * effective family's faces available BEFORE anything can mount a terminal — mountTerminal
 * measures the cell grid synchronously, so the face must be ready by first render. A no-op for
 * the system default and custom families (nothing bundled to load).
 */
export async function ensureStartupFontLoaded(settings: SettingsStore): Promise<void> {
  const family = settings.get("terminal.fontFamily");
  if (!isBundledFamily(family)) return;
  await ensureFontLoaded(family);
}
