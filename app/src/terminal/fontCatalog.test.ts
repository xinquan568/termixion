// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-204: the bundled-font catalog — the single source of truth for the five @font-face
// family names, the default flip to SauceCodePro Nerd Font Mono, the stack composition at the
// display chokepoint, and the never-throwing font-load gate. R8: written before the module.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_FONTS,
  DEFAULT_FONT_FAMILY,
  ensureFontLoaded,
  ensureStartupFontLoaded,
  fontStackFor,
  isBundledFamily,
} from "./fontCatalog";
import { ITERM2_FONT_FAMILY } from "./iterm2Theme";
import { makeSettingsStore, type KeyValueStore } from "../settings/settingsStore";

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** Install a fake FontFaceSet on jsdom's document (which ships none); restore in afterEach. */
function stubFonts(load: (spec: string) => Promise<unknown>) {
  const fonts = { load: vi.fn(load) };
  Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
  return fonts;
}

afterEach(() => {
  // jsdom has no document.fonts by default — remove any stub so tests stay independent.
  delete (document as { fonts?: unknown }).fonts;
});

describe("BUNDLED_FONTS catalog", () => {
  it("lists exactly the five families with their CSS-facing names", () => {
    expect(BUNDLED_FONTS.map((f) => f.family)).toEqual([
      "SauceCodePro Nerd Font Mono",
      "JetBrainsMono Nerd Font Mono",
      "MesloLGS NF",
      "Hack Nerd Font Mono",
      "FiraCode Nerd Font Mono",
    ]);
  });

  it("makes SauceCodePro the default, and the default is bundled", () => {
    expect(DEFAULT_FONT_FAMILY).toBe("SauceCodePro Nerd Font Mono");
    expect(isBundledFamily(DEFAULT_FONT_FAMILY)).toBe(true);
  });

  it("isBundledFamily: true for every catalog family, false for '' and custom values", () => {
    for (const f of BUNDLED_FONTS) expect(isBundledFamily(f.family)).toBe(true);
    expect(isBundledFamily("")).toBe(false);
    expect(isBundledFamily("Menlo")).toBe(false);
    expect(isBundledFamily("JetBrains Mono")).toBe(false); // the UNBUNDLED base font
  });
});

describe("fontStackFor", () => {
  it("'' keeps resolving to the platform default stack", () => {
    expect(fontStackFor("")).toBe(ITERM2_FONT_FAMILY);
  });

  it("a bundled family composes family-first with the platform stack as fallback", () => {
    expect(fontStackFor("SauceCodePro Nerd Font Mono")).toBe(
      `"SauceCodePro Nerd Font Mono", ${ITERM2_FONT_FAMILY}`,
    );
    expect(fontStackFor("MesloLGS NF")).toBe(`"MesloLGS NF", ${ITERM2_FONT_FAMILY}`);
  });

  it("a custom value passes through verbatim (the user owns their stack)", () => {
    expect(fontStackFor("Menlo")).toBe("Menlo");
    expect(fontStackFor("Menlo, monospace")).toBe("Menlo, monospace");
  });
});

describe("ensureFontLoaded", () => {
  it("resolves when document.fonts is absent (plain jsdom/browser without FontFaceSet)", async () => {
    await expect(ensureFontLoaded("SauceCodePro Nerd Font Mono")).resolves.toBeUndefined();
  });

  it("loads both the regular and bold faces of the family", async () => {
    const fonts = stubFonts(() => Promise.resolve([]));
    await ensureFontLoaded("Hack Nerd Font Mono");
    expect(fonts.load).toHaveBeenCalledWith('12px "Hack Nerd Font Mono"');
    expect(fonts.load).toHaveBeenCalledWith('bold 12px "Hack Nerd Font Mono"');
  });

  it("never throws: a rejecting load resolves anyway (fallback stack takes over)", async () => {
    stubFonts(() => Promise.reject(new Error("404")));
    await expect(ensureFontLoaded("FiraCode Nerd Font Mono")).resolves.toBeUndefined();
  });

  it("never throws: a SYNCHRONOUSLY throwing fonts.load resolves anyway (step-8 finding 3)", async () => {
    stubFonts(() => {
      throw new Error("invalid font shorthand");
    });
    await expect(ensureFontLoaded("MesloLGS NF")).resolves.toBeUndefined();
  });

  it("never hangs: a stuck load resolves after the timeout", async () => {
    stubFonts(() => new Promise(() => {})); // never settles
    await expect(
      ensureFontLoaded("JetBrainsMono Nerd Font Mono", 20),
    ).resolves.toBeUndefined();
  });
});

describe("ensureStartupFontLoaded (the boot gate)", () => {
  it("loads the effective family when it is bundled (the fresh-profile default)", async () => {
    const fonts = stubFonts(() => Promise.resolve([]));
    await ensureStartupFontLoaded(makeSettingsStore(fakeStorage()));
    expect(fonts.load).toHaveBeenCalledWith(`12px "${DEFAULT_FONT_FAMILY}"`);
  });

  it("is a no-op for the system default ('')", async () => {
    const fonts = stubFonts(() => Promise.resolve([]));
    await ensureStartupFontLoaded(
      makeSettingsStore(fakeStorage({ "termixion.terminal.fontFamily": "" })),
    );
    expect(fonts.load).not.toHaveBeenCalled();
  });

  it("is a no-op for a custom family", async () => {
    const fonts = stubFonts(() => Promise.resolve([]));
    await ensureStartupFontLoaded(
      makeSettingsStore(fakeStorage({ "termixion.terminal.fontFamily": "Menlo" })),
    );
    expect(fonts.load).not.toHaveBeenCalled();
  });
});
