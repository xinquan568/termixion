// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the surface router decides which surface this webview renders — the terminal (main
// window) or the settings window — from the window's URL query. Pure, so it behaves identically
// under Tauri, `pnpm dev` in a plain browser, and jsdom.
import { describe, it, expect } from "vitest";
import { resolveSurface } from "./surface";

describe("resolveSurface", () => {
  it("defaults to the terminal surface", () => {
    expect(resolveSurface("")).toEqual({ kind: "terminal" });
    expect(resolveSurface("?foo=bar")).toEqual({ kind: "terminal" });
  });

  it("routes ?window=settings to the settings surface with no section", () => {
    expect(resolveSurface("?window=settings")).toEqual({ kind: "settings", section: null });
  });

  it("carries a valid section through", () => {
    expect(resolveSurface("?window=settings&section=about")).toEqual({
      kind: "settings",
      section: "about",
    });
    expect(resolveSurface("?window=settings&section=terminal")).toEqual({
      kind: "settings",
      section: "terminal",
    });
  });

  it("drops an unknown section rather than crashing", () => {
    expect(resolveSurface("?window=settings&section=nope")).toEqual({
      kind: "settings",
      section: null,
    });
  });

  it("treats junk and non-settings values as the terminal surface, never throwing", () => {
    expect(resolveSurface("?window=other")).toEqual({ kind: "terminal" });
    expect(resolveSurface("%%%not-a-query")).toEqual({ kind: "terminal" });
  });
});
