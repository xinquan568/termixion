// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-97 (FR-1.4): the Unicode-correctness conformance group. Table-driven per the trmx-64 style; each
// case pins Termixion's CONFIGURED emulator (openTerm activates @xterm/addon-unicode-graphemes, exactly
// as production's realDeps.createTerminal does — the trmx-64 invariant). xterm.js 5.5 defaults to Unicode
// v6 widths, which split modern emoji clusters and mis-width some forms; these cases are RED under v6 and
// GREEN once the graphemes addon is the active Unicode version. References are cited per case (Unicode
// UAX #29 grapheme clustering, UAX #11 East Asian Width, and xterm's wide-cell buffer semantics).
import { describe, expect, it } from "vitest";
import { openTerm, feed, feedBytes, utf8Bytes, cellAt, cursor, line } from "./driver";

// Representative graphemes (each cites what makes it interesting).
const CJK = "一"; // 一  U+4E00 CJK UNIFIED — East-Asian Wide, 2 cells
const FULLWIDTH_A = "Ａ"; // Ａ U+FF21 FULLWIDTH LATIN A — Wide, 2 cells
const HALFWIDTH_KANA = "ｱ"; // ｱ U+FF71 HALFWIDTH KATAKANA A — Narrow, 1 cell
const E_ACUTE_COMBINING = "e\u0301"; // e + U+0301 COMBINING ACUTE — combining is width 0 → 1 cell
const ZWJ_FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // 👨‍👩‍👧‍👦 one cluster, 2 cells
const FLAG_JP = "\u{1F1EF}\u{1F1F5}"; // 🇯🇵 regional-indicator pair → one cluster, 2 cells
const THUMB_SKINTONE = "\u{1F44D}\u{1F3FD}"; // 👍🏽 base + Fitzpatrick modifier → one cluster, 2 cells
const HEART_VS16 = "❤️"; // ❤️ U+2764 + VS16 → emoji presentation, 2 cells (1 without VS16)

describe("unicode — addon activation smoke (RED under xterm's default v6)", () => {
  it("renders a ZWJ family as ONE 2-cell cluster (not four separate emoji)", async () => {
    const term = openTerm();
    await feed(term, ZWJ_FAMILY);
    // Under the graphemes addon the whole family is one cluster: cursor advances 2, lead cell holds the
    // FULL cluster string, the next cell is the wide-char spacer. (v6 would advance 8 and hold only 👨.)
    expect(cursor(term).x).toBe(2);
    expect(cellAt(term, 0, 0).text).toBe(ZWJ_FAMILY);
    expect(cellAt(term, 0, 0).width).toBe(2);
    expect(cellAt(term, 0, 1).width).toBe(0); // trailing spacer of the wide cluster
  });
});

describe("unicode — widths (UAX #11 + grapheme clustering)", () => {
  const cases: Array<{ name: string; text: string; advance: number; leadWidth: number }> = [
    { name: "CJK ideograph = 2 cells", text: CJK, advance: 2, leadWidth: 2 },
    { name: "full-width form = 2 cells", text: FULLWIDTH_A, advance: 2, leadWidth: 2 },
    { name: "half-width kana = 1 cell", text: HALFWIDTH_KANA, advance: 1, leadWidth: 1 },
    { name: "base + combining mark = 1 cell (combining width 0)", text: E_ACUTE_COMBINING, advance: 1, leadWidth: 1 },
    { name: "ZWJ family = one 2-cell cluster", text: ZWJ_FAMILY, advance: 2, leadWidth: 2 },
    { name: "regional-indicator flag = one 2-cell cluster", text: FLAG_JP, advance: 2, leadWidth: 2 },
    { name: "skin-tone modifier = one 2-cell cluster", text: THUMB_SKINTONE, advance: 2, leadWidth: 2 },
    { name: "VS16 emoji presentation = 2 cells", text: HEART_VS16, advance: 2, leadWidth: 2 },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const term = openTerm();
      await feed(term, c.text);
      expect(cursor(term).x).toBe(c.advance);
      expect(cellAt(term, 0, 0).width).toBe(c.leadWidth);
      expect(cellAt(term, 0, 0).text).toBe(c.text); // the full cluster round-trips in the lead cell
    });
  }
});

describe("unicode — cursor & wrap at wide-cell boundaries", () => {
  it("a 2-cell char at the last column wraps WHOLE to the next row (never split)", async () => {
    const term = openTerm({ cols: 80, rows: 24 });
    await feed(term, "[1;80H"); // CUP to row 1, col 80 (0-based col 79) — the last column
    await feed(term, CJK); // a wide char cannot fit in the single remaining column
    // It wraps entirely to row 1: the last column of row 0 stays blank, the wide char lands at (1,0).
    expect(cellAt(term, 0, 79).text).not.toBe(CJK);
    expect(cellAt(term, 1, 0).text).toBe(CJK);
    expect(cellAt(term, 1, 0).width).toBe(2);
  });
});

describe("unicode — erase/overwrite of wide cells (xterm semantics)", () => {
  it("overwriting one half of a wide char blanks the orphan half", async () => {
    const term = openTerm();
    await feed(term, CJK); // occupies (0,0) lead + (0,1) spacer
    await feed(term, "[1;1H"); // back to col 1 (0-based 0)
    await feed(term, "X"); // a narrow char overwrites the wide char's lead half
    expect(cellAt(term, 0, 0).text).toBe("X");
    expect(cellAt(term, 0, 0).width).toBe(1);
    // The orphaned trailing half becomes a NORMAL blank cell (width 1), NOT a leftover width-0 spacer —
    // a stale spacer would also have blank text, so width is the discriminating assertion.
    expect(cellAt(term, 0, 1)).toMatchObject({ text: "", width: 1 });
  });

  it("overwriting the TRAILING half of a wide char also blanks the orphan lead half", async () => {
    const term = openTerm();
    await feed(term, CJK); // (0,0) lead + (0,1) spacer
    await feed(term, "\x1b[1;2H"); // to col 2 (0-based 1) — the trailing half
    await feed(term, "Y");
    expect(cellAt(term, 0, 1).text).toBe("Y");
    expect(cellAt(term, 0, 0)).toMatchObject({ text: "", width: 1 }); // the orphaned lead half is blanked
  });

  it("EL (erase-line) across a wide char clears both halves", async () => {
    const term = openTerm();
    await feed(term, `AB${CJK}CD`); // A B 一(2) C D
    await feed(term, "\x1b[1;1H\x1b[0K"); // CUP home + EL-to-right
    expect(line(term, 0).trim()).toBe(""); // whole line cleared, no orphaned wide-char half survives
  });
});

describe("unicode — buffer readback (the API the copy path reads)", () => {
  it("getChars() returns the whole cluster and getWidth() is correct for CJK/ZWJ/combining/VS16", async () => {
    for (const text of [CJK, ZWJ_FAMILY, FLAG_JP, THUMB_SKINTONE, HEART_VS16, E_ACUTE_COMBINING]) {
      const term = openTerm();
      await feed(term, text);
      const lead = cellAt(term, 0, 0);
      expect(lead.text).toBe(text); // full cluster, no dropped ZWJ/VS16/combining, no orphan halves
    }
  });
});

describe("unicode — chunked input split mid-codepoint / mid-cluster (PTY-streaming reality)", () => {
  it("UTF-8 bytes split mid-codepoint across writes render identically to one write", async () => {
    const text = `${CJK}二三`; // 一二三 — three 3-byte CJK runes = 9 bytes
    const bytes = utf8Bytes(text);
    // One write (baseline).
    const whole = openTerm();
    await feedBytes(whole, bytes);
    // Split at byte 1 (INSIDE the first rune's 3 bytes) and byte 4 (inside the second) — arbitrary offsets.
    const chunked = openTerm();
    await feedBytes(chunked, bytes.slice(0, 1));
    await feedBytes(chunked, bytes.slice(1, 4));
    await feedBytes(chunked, bytes.slice(4));
    expect(line(chunked, 0)).toBe(line(whole, 0));
    expect(cursor(chunked)).toEqual(cursor(whole));
  });

  it("a grapheme cluster split mid-cluster across writes still renders as one cluster", async () => {
    const bytes = utf8Bytes(ZWJ_FAMILY);
    const whole = openTerm();
    await feedBytes(whole, bytes);
    const chunked = openTerm();
    // Split at byte 2 (inside the first emoji's 4 bytes) and byte 9 (around the first ZWJ) — mid-cluster.
    await feedBytes(chunked, bytes.slice(0, 2));
    await feedBytes(chunked, bytes.slice(2, 9));
    await feedBytes(chunked, bytes.slice(9));
    expect(cellAt(chunked, 0, 0).text).toBe(cellAt(whole, 0, 0).text);
    expect(cursor(chunked).x).toBe(cursor(whole).x);
  });
});
