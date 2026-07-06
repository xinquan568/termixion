// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-97 (FR-1.4): Unicode correctness. xterm.js 5.5 defaults to Unicode v6 widths, which mis-width
// modern emoji (ZWJ sequences, flags, skin tones, VS16) and some CJK. `@xterm/addon-unicode-graphemes`
// replaces the width tables with real grapheme-cluster segmentation. This is the ONE place activation
// lives, imported by BOTH consumers so the conformance harness pins the exact emulator production ships
// (the trmx-64 invariant): (1) production, inside `realDeps.createTerminal` (TerminalView.tsx); (2) the
// headless conformance driver (`conformance/driver.ts` `openTerm`). Activation is `loadAddon` + set
// `unicode.activeVersion` — NOT a constructor option — so it cannot live in the pure `emulationOptions`
// slice. Both `@xterm/xterm` and `@xterm/headless` expose `.unicode.activeVersion` publicly, so no
// internal cast is needed; the structural `UnicodeActivatable` type serves either Terminal.
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { ITerminalAddon } from "@xterm/xterm";

/** The Unicode version id the graphemes addon registers (confirmed against @xterm/addon-unicode-graphemes 0.4.0). */
export const GRAPHEMES_VERSION = "15-graphemes";

/**
 * The minimal terminal surface activation needs — satisfied structurally by BOTH the browser
 * (`@xterm/xterm`) and headless (`@xterm/headless`) Terminals, so one helper serves production and the
 * conformance driver identically.
 */
export interface UnicodeActivatable {
  loadAddon(addon: ITerminalAddon): void;
  unicode: { activeVersion: string };
}

/**
 * Load the grapheme-cluster addon and make it the active Unicode version (correct widths + segmentation
 * for CJK / emoji / combining marks). Call once, right after the terminal is constructed.
 */
export function activateUnicodeGraphemes(term: UnicodeActivatable): void {
  term.loadAddon(new UnicodeGraphemesAddon());
  term.unicode.activeVersion = GRAPHEMES_VERSION;
}
