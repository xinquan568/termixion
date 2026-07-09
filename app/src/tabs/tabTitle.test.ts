// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-75/166 (FR-2.4, test-first): the pure title model. A PANE's effective title is chosen from
// its automatic SOURCES with fixed precedence — OSC 0/2 escape > foreground-process hint > fallback
// — where a slot that is absent OR sanitizes to empty simply does not count. trmx-166: the user's
// manual rename left this ladder; it is a TAB-scoped pin combined with the focused pane via
// `tabTitle(manualTitle, focused)`. Sanitization (C0/C1 control strip, trim, 256-char cap) is pinned
// here headless: no React, no reducer — just strings in / strings out, so the tabState reducer and
// the App wiring can lean on these exact semantics. Control characters are spelled as \u{..} escapes
// so the source stays greppable.
import { describe, it, expect } from "vitest";
import {
  effectiveTitle,
  MAX_TITLE_LENGTH,
  sanitizeTitle,
  tabTitle,
  type TitleSources,
} from "./tabTitle";

describe("sanitizeTitle", () => {
  it("passes a clean title through unchanged", () => {
    expect(sanitizeTitle("vim ~/notes.md")).toBe("vim ~/notes.md");
  });

  it("strips C0 controls (NUL, BEL, ESC, newline, tab, CR)", () => {
    expect(sanitizeTitle("a\u{0}b\u{7}c\u{1b}d")).toBe("abcd");
    // \n / \t / \r are C0 too: STRIPPED, not turned into spaces (a title is one line).
    expect(sanitizeTitle("one\ntwo\tthree\rfour")).toBe("onetwothreefour");
  });

  it("strips DEL (0x7f) and C1 controls (0x80–0x9f)", () => {
    expect(sanitizeTitle("a\u{7f}b\u{80}c\u{9f}d")).toBe("abcd");
    // 0xa0 (NBSP) is one past the C1 range — NOT a control, an interior NBSP survives.
    expect(sanitizeTitle("a\u{a0}b")).toBe("a\u{a0}b");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeTitle("   build   ")).toBe("build");
  });

  it("strips controls BEFORE trimming, so control-wrapped padding still trims away", () => {
    expect(sanitizeTitle("\u{7}  hi  \u{7}")).toBe("hi");
  });

  it("whitespace-only, control-only, and empty input all sanitize to the empty string", () => {
    expect(sanitizeTitle("")).toBe("");
    expect(sanitizeTitle("   ")).toBe("");
    expect(sanitizeTitle("\u{7}\u{1b}\u{9f}")).toBe("");
    expect(sanitizeTitle(" \u{7} \t ")).toBe("");
  });

  it(`caps at MAX_TITLE_LENGTH (${MAX_TITLE_LENGTH}) characters`, () => {
    expect(MAX_TITLE_LENGTH).toBe(256);
    expect(sanitizeTitle("x".repeat(300))).toBe("x".repeat(256));
    // Exactly at the cap is untouched.
    expect(sanitizeTitle("x".repeat(256))).toBe("x".repeat(256));
  });

  it("caps by CODE POINTS — a surrogate pair (emoji) is never torn at the cap", () => {
    const capped = sanitizeTitle("\u{1F680}".repeat(300)); // rocket ×300 = 600 UTF-16 units
    expect(capped).toBe("\u{1F680}".repeat(256));
    expect([...capped]).toHaveLength(MAX_TITLE_LENGTH);
  });

  it("CJK and emoji pass through untouched", () => {
    expect(sanitizeTitle("构建 \u{1F680} done")).toBe("构建 \u{1F680} done");
  });
});

describe("effectiveTitle", () => {
  const F = "Shell";

  // The FULL presence table over the two optional automatic slots + fallback (trmx-166: manual is
  // no longer a pane source — see the tabTitle describe below).
  const table: Array<[string, TitleSources, string]> = [
    ["osc+process", { osc: "o", process: "p", fallback: F }, "o"],
    ["osc only", { osc: "o", fallback: F }, "o"],
    ["process only", { process: "p", fallback: F }, "p"],
    ["none (fallback)", { fallback: F }, F],
  ];
  it.each(table)("precedence osc > process > fallback: %s", (_name, sources, want) => {
    expect(effectiveTitle(sources)).toBe(want);
  });

  it("a present slot that sanitizes to empty does NOT count — precedence falls through it", () => {
    expect(effectiveTitle({ osc: "   ", process: "sleep", fallback: F })).toBe("sleep");
    expect(effectiveTitle({ osc: "\u{7} ", process: "sleep", fallback: F })).toBe("sleep");
    expect(effectiveTitle({ osc: "\u{1b}", process: "  ", fallback: F })).toBe(F);
  });

  it("sanitizes the winning slot's value", () => {
    expect(effectiveTitle({ osc: " wo\u{7}rk ", process: "vim", fallback: F })).toBe("work");
    expect(effectiveTitle({ process: "p".repeat(300), fallback: F })).toBe("p".repeat(256));
  });

  it("returns the SANITIZED fallback when nothing counts — even empty (the reducer keeps its fallback non-empty)", () => {
    expect(effectiveTitle({ fallback: " zsh\u{0} " })).toBe("zsh");
    expect(effectiveTitle({ fallback: " \u{7} " })).toBe("");
  });
});

// trmx-166: the tab-scoped manual PIN combined with the focused pane. A non-empty (after sanitize)
// manual title wins over the focused pane's effective title; an absent / empty / whitespace-only
// manual falls through to the focused pane ("clear to auto"). Manual is sanitized on the same terms.
describe("tabTitle (trmx-166)", () => {
  const F = "Shell";

  it("a non-empty manual pin wins over the focused pane's effective title", () => {
    expect(tabTitle("My Tab", { osc: "vim", fallback: F })).toBe("My Tab");
    expect(tabTitle("My Tab", { fallback: F })).toBe("My Tab");
  });

  it("an absent / empty / whitespace-only manual falls through to the focused pane (auto)", () => {
    expect(tabTitle(undefined, { osc: "vim", fallback: F })).toBe("vim");
    expect(tabTitle("", { process: "sleep", fallback: F })).toBe("sleep");
    expect(tabTitle("   ", { osc: "vim", fallback: F })).toBe("vim");
    expect(tabTitle("\u{7}\u{1b}", { fallback: F })).toBe(F); // control-only manual ⇒ auto
  });

  it("sanitizes the manual pin (controls stripped, trimmed, capped)", () => {
    expect(tabTitle(" wo\u{7}rk ", { osc: "vim", fallback: F })).toBe("work");
    expect(tabTitle("x".repeat(300), { fallback: F })).toBe("x".repeat(256));
  });
});
