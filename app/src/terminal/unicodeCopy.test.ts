// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-97 (FR-1.4): copy correctness — the FR's explicit clause. Selecting rendered CJK / ZWJ emoji /
// combining sequences must round-trip to the clipboard byte-for-byte (no orphan half-cells, no dropped
// ZWJ/VS16, no double-width padding). This exercises the REAL browser path — a `@xterm/xterm` Terminal
// (grapheme addon active, exactly as production) rendered in jsdom, driven through the public selection
// API — and asserts `terminal.getSelection()`, which is what the shared `selectionText` (trmx-66/95)
// and BOTH ⌘C + auto-copy read. (jsdom runs xterm's SelectionService given a matchMedia stub; the
// packaged manual checklist still covers real mouse-drag selection + the system clipboard.)
import { describe, it, expect, beforeAll } from "vitest";
import { Terminal } from "@xterm/xterm";
import { activateUnicodeGraphemes } from "./unicodeGraphemes";
import { selectionText, type CopyTerminalLike } from "./clipboard";

beforeAll(() => {
  // xterm's renderer calls window.matchMedia on open(); jsdom omits it.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

/** A grapheme-active browser terminal rendered into a fresh jsdom container, with `text` written. */
async function renderedTerm(text: string): Promise<Terminal> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  activateUnicodeGraphemes(term);
  term.open(container);
  await new Promise<void>((resolve) => term.write(text, () => resolve()));
  return term;
}

const CJK3 = "一二三"; // three 2-cell CJK ideographs
const ZWJ_FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // 👨‍👩‍👧‍👦
const FLAG_JP = "\u{1F1EF}\u{1F1F5}"; // 🇯🇵
const E_ACUTE = "é"; // e + U+0301 combining

describe("unicode copy — getSelection() round-trips clusters exactly", () => {
  it("CJK: a 3-ideograph run selects back byte-for-byte (6 cells → 3 runes)", async () => {
    const term = await renderedTerm(CJK3);
    term.select(0, 0, 6); // 6 columns = the three wide chars
    expect(term.getSelection()).toBe(CJK3);
  });

  it("ZWJ family: the whole cluster round-trips (no dropped ZWJ, no orphan half)", async () => {
    const term = await renderedTerm(ZWJ_FAMILY);
    term.select(0, 0, 2); // the cluster occupies 2 cells
    expect(term.getSelection()).toBe(ZWJ_FAMILY);
  });

  it("regional-indicator flag: both indicators round-trip", async () => {
    const term = await renderedTerm(FLAG_JP);
    term.select(0, 0, 2);
    expect(term.getSelection()).toBe(FLAG_JP);
  });

  it("combining mark stays attached to its base", async () => {
    const term = await renderedTerm(E_ACUTE);
    term.select(0, 0, 1); // one cell (combining is width 0)
    expect(term.getSelection()).toBe(E_ACUTE);
  });

  it("mixed-width multi-line selection preserves line breaks", async () => {
    const term = await renderedTerm("一二\r\nAB\r\n三");
    term.selectLines(0, 2);
    // xterm joins rows with \n and right-trims each; the mixed-width content survives intact.
    expect(term.getSelection()).toBe("一二\nAB\n三");
  });

  it("the shared selectionText path (⌘C == auto-copy) yields the same bytes as getSelection()", async () => {
    const term = await renderedTerm(`${CJK3} ${ZWJ_FAMILY}`);
    term.selectAll();
    // selectionText is the ONE extraction both ⌘C (handleCopyEvent) and auto-copy (copyOnSelect) call.
    expect(selectionText(term as unknown as CopyTerminalLike)).toBe(term.getSelection());
    expect(term.getSelection()).toContain(CJK3);
    expect(term.getSelection()).toContain(ZWJ_FAMILY);
  });
});
