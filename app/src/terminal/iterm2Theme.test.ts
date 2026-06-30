// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-44 (test-first): the pure iTerm2 default-appearance values. These mirror iTerm2's shipped default
// profile (codes/iTerm2/plists/DefaultBookmark.plist): Monaco 12, 1.0 line spacing, a solid non-blinking
// block cursor, and the adaptive light/dark palette (the 16 ANSI colors are identical across modes; only
// the primaries flip). Asserting exact values here keeps the "match iTerm2" promise checkable.
import { describe, it, expect } from "vitest";
import {
  ITERM2_ANSI,
  ITERM2_FONT_FAMILY,
  ITERM2_FONT_SIZE,
  iterm2Theme,
  iterm2TerminalOptions,
  prefersDarkToMode,
} from "./iterm2Theme";

// The 16 ANSI colors iTerm2 ships (same in dark and light mode).
const ANSI = {
  black: "#14191E",
  red: "#B43C2A",
  green: "#00C200",
  yellow: "#C7C400",
  blue: "#2744C7",
  magenta: "#C040BE",
  cyan: "#00C5C7",
  white: "#C7C7C7",
  brightBlack: "#686868",
  brightRed: "#DD7975",
  brightGreen: "#58E790",
  brightYellow: "#ECE100",
  brightBlue: "#A7ABF2",
  brightMagenta: "#E17EE1",
  brightCyan: "#60FDFF",
  brightWhite: "#FFFFFF",
};

describe("iterm2Theme", () => {
  it("exposes the 16 iTerm2 ANSI colors", () => {
    expect(ITERM2_ANSI).toEqual(ANSI);
  });

  it("builds the exact dark-mode theme", () => {
    expect(iterm2Theme("dark")).toEqual({
      foreground: "#DCDCDC",
      background: "#15191F",
      cursor: "#FFFFFF",
      cursorAccent: "#000000",
      selectionBackground: "#B3D7FF",
      selectionForeground: "#000000",
      ...ANSI,
    });
  });

  it("builds the exact light-mode theme (same ANSI, flipped primaries)", () => {
    expect(iterm2Theme("light")).toEqual({
      foreground: "#101010",
      background: "#FAFAFA",
      cursor: "#000000",
      cursorAccent: "#FFFFFF",
      selectionBackground: "#B3D7FF",
      selectionForeground: "#000000",
      ...ANSI,
    });
  });

  it("maps the system appearance preference to a mode", () => {
    expect(prefersDarkToMode(true)).toBe("dark");
    expect(prefersDarkToMode(false)).toBe("light");
  });
});

describe("iterm2TerminalOptions", () => {
  it("uses Monaco 12 with iTerm2's spacing and a solid non-blinking block cursor", () => {
    const opts = iterm2TerminalOptions("dark");
    expect(ITERM2_FONT_FAMILY).toContain("Monaco");
    expect(ITERM2_FONT_SIZE).toBe(12);
    expect(opts.fontFamily).toBe(ITERM2_FONT_FAMILY);
    expect(opts.fontSize).toBe(12);
    expect(opts.lineHeight).toBe(1);
    expect(opts.letterSpacing).toBe(0);
    expect(opts.cursorStyle).toBe("block");
    expect(opts.cursorBlink).toBe(false);
    expect(opts.drawBoldTextInBrightColors).toBe(true);
    expect(opts.convertEol).toBe(true);
  });

  it("carries the mode's theme", () => {
    expect(iterm2TerminalOptions("dark").theme).toEqual(iterm2Theme("dark"));
    expect(iterm2TerminalOptions("light").theme).toEqual(iterm2Theme("light"));
  });
});
