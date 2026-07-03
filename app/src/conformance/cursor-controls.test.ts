// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (FR-2, group 1): cursor-motion conformance — addressing, relative moves with counts and
// edge clamping, control characters, tab stops, index family, and cursor save/restore. This group
// carries THE trmx-64 pin: with the production `convertEol: false`, a bare LF indexes down and
// KEEPS the column (VT semantics); the pre-fix `convertEol: true` rewrote LF into CR+LF and broke
// every full-screen TUI's cursor motion. Each case cites its vttest menu item / esctest analog.
import { describe, it, expect } from "vitest";
import { openTerm, feed, line, cellAt, cursor } from "./driver";

/** One motion case: feed `seq` into a fresh 80x24 terminal, expect the cursor at 0-based (x, y). */
interface MoveCase {
  name: string;
  seq: string;
  x: number;
  y: number;
}

const MOVES: MoveCase[] = [
  // vttest 1: cursor movements — CUP addressing is 1-based (row;col), buffer coords 0-based.
  { name: "CUP 10;20 addresses 1-based", seq: "\x1b[10;20H", x: 19, y: 9 },
  // vttest 1: cursor movements — CUP with no parameters homes the cursor.
  { name: "CUP without params homes", seq: "\x1b[5;5H\x1b[H", x: 0, y: 0 },
  // vttest 1: cursor movements — CUP clamps to the screen's bottom-right corner.
  { name: "CUP 999;999 clamps to 24;80", seq: "\x1b[999;999H", x: 79, y: 23 },
  // vttest 1: cursor movements — HVP (CSI f) is the CUP twin.
  { name: "HVP 5;7 addresses like CUP", seq: "\x1b[5;7f", x: 6, y: 4 },
  // vttest 1: cursor movements — CUU with a count.
  { name: "CUU 3 moves up three rows", seq: "\x1b[10;7H\x1b[3A", x: 6, y: 6 },
  // vttest 1: cursor movements — CUU clamps at the top edge.
  { name: "CUU 99 clamps at row 1", seq: "\x1b[2;7H\x1b[99A", x: 6, y: 0 },
  // vttest 1: cursor movements — CUD with a count.
  { name: "CUD 4 moves down four rows", seq: "\x1b[5;3H\x1b[4B", x: 2, y: 8 },
  // vttest 1: cursor movements — CUD clamps at the bottom edge.
  { name: "CUD 99 clamps at row 24", seq: "\x1b[5;3H\x1b[99B", x: 2, y: 23 },
  // vttest 1: cursor movements — CUF with a count.
  { name: "CUF 5 moves right five cols", seq: "\x1b[1;1H\x1b[5C", x: 5, y: 0 },
  // vttest 1: cursor movements — CUF clamps at the right edge (no wrap-pending from CUF).
  { name: "CUF 99 clamps at col 80", seq: "\x1b[1;70H\x1b[99C", x: 79, y: 0 },
  // vttest 1: cursor movements — CUB with a count.
  { name: "CUB 4 moves left four cols", seq: "\x1b[1;10H\x1b[4D", x: 5, y: 0 },
  // vttest 1: cursor movements — CUB clamps at the left edge.
  { name: "CUB 99 clamps at col 1", seq: "\x1b[1;10H\x1b[99D", x: 0, y: 0 },
  // esctest: CNL (CSI E) — down N rows AND to column 1.
  { name: "CNL 2 moves down to col 1", seq: "\x1b[5;10H\x1b[2E", x: 0, y: 6 },
  // esctest: CPL (CSI F) — up N rows AND to column 1.
  { name: "CPL 3 moves up to col 1", seq: "\x1b[7;10H\x1b[3F", x: 0, y: 3 },
  // esctest: CHA (CSI G) — absolute column, row unchanged.
  { name: "CHA 15 jumps to column 15", seq: "\x1b[3;10H\x1b[15G", x: 14, y: 2 },
  // esctest: VPA (CSI d) — absolute row, column unchanged.
  { name: "VPA 8 jumps to row 8", seq: "\x1b[4;10H\x1b[8d", x: 9, y: 7 },
  // vttest 1: cursor movements — BS steps left without erasing.
  { name: "BS steps the cursor left", seq: "abcd\b\b", x: 2, y: 0 },
  // vttest 1: cursor movements — BS stops at the left margin.
  { name: "BS clamps at the left margin", seq: "a\b\b\b", x: 0, y: 0 },
  // vttest 1: cursor movements — CR returns to column 1 on the same row.
  { name: "CR returns to col 1", seq: "abcd\r", x: 0, y: 0 },
  // esctest: IND (ESC D) — index down, column kept (no scroll mid-screen).
  { name: "IND moves down keeping col", seq: "\x1b[3;5H\x1bD", x: 4, y: 3 },
  // esctest: RI (ESC M) — reverse index up, column kept (no scroll mid-screen).
  { name: "RI moves up keeping col", seq: "\x1b[3;5H\x1bM", x: 4, y: 1 },
  // esctest: NEL (ESC E) — next line, column 1.
  { name: "NEL moves to next row col 1", seq: "abc\x1bE", x: 0, y: 1 },
  // vttest 1: cursor movements — TAB advances to the next default 8-column stop.
  { name: "TAB advances to col 9", seq: "\t", x: 8, y: 0 },
  // vttest 1: cursor movements — successive TABs walk the default stops.
  { name: "TAB x3 advances to col 25", seq: "\t\t\t", x: 24, y: 0 },
  // esctest: CHT (CSI I) — cursor forward N tab stops.
  { name: "CHT 2 skips two stops", seq: "\x1b[2I", x: 16, y: 0 },
  // esctest: CBT (CSI Z) — cursor backward N tab stops.
  { name: "CBT 1 backs up one stop", seq: "\x1b[1;17H\x1b[1Z", x: 8, y: 0 },
];

describe("conformance: cursor controls", () => {
  it.each(MOVES)("$name", async ({ seq, x, y }) => {
    const term = openTerm();
    await feed(term, seq);
    expect(cursor(term)).toEqual({ x, y });
  });

  // vttest 1: cursor movements / trmx-64 FIX PIN — with the production `convertEol: false`, a bare
  // LF indexes down and KEEPS the column: after "abc" the cursor is at col 4, so 'd' lands at
  // row 1 col 3 (0-based), not at col 0. `convertEol: true` (the pre-fix config) would have made
  // row 1 read "def" from column 1 — this case is the regression tripwire.
  it("LF keeps the column (trmx-64 pin)", async () => {
    const term = openTerm();
    await feed(term, "abc\ndef");
    expect(line(term, 0)).toBe("abc");
    expect(line(term, 1)).toBe("   def");
    expect(cellAt(term, 1, 3).text).toBe("d");
    expect(cursor(term)).toEqual({ x: 6, y: 1 });
  });

  // vttest 1: cursor movements — LF on the bottom row scrolls the screen up one line into the
  // scrollback (baseY grows) and still keeps the column.
  it("LF at the bottom row scrolls and keeps the column", async () => {
    const term = openTerm({ rows: 5 });
    await feed(term, "first\x1b[5;10H\n");
    expect(term.buffer.active.baseY).toBe(1);
    expect(cursor(term)).toEqual({ x: 9, y: 4 });
    // Buffer row 0 is now scrollback; "first" is preserved there.
    expect(line(term, 0)).toBe("first");
  });

  // esctest: IND (ESC D) — at the bottom row IND scrolls up like LF.
  it("IND at the bottom row scrolls the screen", async () => {
    const term = openTerm({ rows: 5 });
    await feed(term, "top\x1b[5;1Hbottom\x1bD");
    expect(term.buffer.active.baseY).toBe(1);
    expect(cursor(term)).toEqual({ x: 6, y: 4 });
    expect(line(term, 0)).toBe("top");
  });

  // esctest: RI (ESC M) — at the top row RI scrolls the screen DOWN, pushing row 1 to row 2.
  it("RI at the top row scrolls the screen down", async () => {
    const term = openTerm({ rows: 5 });
    await feed(term, "first\x1b[1;3H\x1bM");
    expect(cursor(term)).toEqual({ x: 2, y: 0 });
    expect(line(term, 0)).toBe("");
    expect(line(term, 1)).toBe("first");
  });

  // esctest: HTS (ESC H) — set a tab stop at the cursor; TAB from col 1 lands on it.
  it("HTS sets a custom tab stop", async () => {
    const term = openTerm();
    await feed(term, "\x1b[1;5H\x1bH\r\t");
    expect(cursor(term)).toEqual({ x: 4, y: 0 });
  });

  // esctest: TBC 0 (CSI 0 g) — clear the stop at the cursor only; TAB falls through to the next
  // default stop at col 9.
  it("TBC 0 clears the stop at the cursor", async () => {
    const term = openTerm();
    await feed(term, "\x1b[1;5H\x1bH\x1b[1;5H\x1b[0g\r\t");
    expect(cursor(term)).toEqual({ x: 8, y: 0 });
  });

  // esctest: TBC 3 (CSI 3 g) — clear ALL stops; TAB runs to the right margin.
  it("TBC 3 clears all tab stops", async () => {
    const term = openTerm();
    await feed(term, "\x1b[3g\r\t");
    expect(cursor(term)).toEqual({ x: 79, y: 0 });
  });

  // vttest 8 / esctest: DECSC+DECRC (ESC 7 / ESC 8) — restore brings back BOTH the position and
  // the saved SGR: the 'X' written after DECRC lands at the saved spot in the saved red (palette 1)
  // even though SGR was reset to default in between.
  it("DECSC/DECRC restore position and SGR", async () => {
    const term = openTerm();
    await feed(term, "\x1b[5;10H\x1b[31m\x1b7\x1b[H\x1b[0m\x1b8X");
    expect(cursor(term)).toEqual({ x: 10, y: 4 });
    const c = cellAt(term, 4, 9);
    expect(c.text).toBe("X");
    expect(c.fgMode).toBe("palette");
    expect(c.fg).toBe(1);
  });
});
