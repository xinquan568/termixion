// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (FR-2, group 2): erase and edit conformance — ED/EL erasure in all three directions,
// ICH/DCH/ECH cell edits within a line, and IL/DL line shifts. Erase leaves blanks in place;
// insert/delete SHIFT the remainder — the distinction every curses program leans on. Each case
// cites its vttest menu item / esctest analog.
import { describe, it, expect } from "vitest";
import { openTerm, feed, line, cursor } from "./driver";

/** Single-line edit case: prep text, park + edit via `seq`, expect the row text. */
interface LineCase {
  name: string;
  prep: string;
  seq: string;
  want: string;
}

const LINE_EDITS: LineCase[] = [
  // vttest 2: screen features — EL 0 erases from the cursor to end of line (cursor col included).
  { name: "EL 0 erases to end of line", prep: "abcdefgh", seq: "\x1b[1;4H\x1b[0K", want: "abc" },
  // vttest 2: screen features — EL 1 erases from start of line THROUGH the cursor column.
  { name: "EL 1 erases through the cursor", prep: "abcdefgh", seq: "\x1b[1;4H\x1b[1K", want: "    efgh" },
  // vttest 2: screen features — EL 2 erases the whole line.
  { name: "EL 2 erases the whole line", prep: "abcdefgh", seq: "\x1b[2K", want: "" },
  // vttest 8: VT102 insert/delete — ICH shifts the rest of the line right, opening blanks.
  { name: "ICH 2 opens two blanks", prep: "abcdef", seq: "\x1b[1;3H\x1b[2@", want: "ab  cdef" },
  // vttest 8: VT102 insert/delete — DCH deletes cells, pulling the remainder left.
  { name: "DCH 2 pulls the tail left", prep: "abcdef", seq: "\x1b[1;3H\x1b[2P", want: "abef" },
  // vttest 11 / esctest: ECH (VT220) — blanks N cells in place, NO shifting.
  { name: "ECH 2 blanks without shifting", prep: "abcdef", seq: "\x1b[1;3H\x1b[2X", want: "ab  ef" },
];

/** Five-row grid case: prep a 5-row screen, apply `seq`, expect the full grid. */
interface GridCase {
  name: string;
  prep: string;
  seq: string;
  rows: string[];
}

const FIVES = "11111\r\n22222\r\n33333\r\n44444\r\n55555";
const LETTERS = "aa\r\nbb\r\ncc\r\ndd\r\nee";

const GRID_EDITS: GridCase[] = [
  // vttest 2: screen features — ED 0 erases from the cursor to end of screen (rest of the cursor
  // row included).
  {
    name: "ED 0 erases below",
    prep: FIVES,
    seq: "\x1b[3;3H\x1b[0J",
    rows: ["11111", "22222", "33", "", ""],
  },
  // vttest 2: screen features — ED 1 erases from screen start THROUGH the cursor cell.
  {
    name: "ED 1 erases above",
    prep: FIVES,
    seq: "\x1b[3;3H\x1b[1J",
    rows: ["", "", "   33", "44444", "55555"],
  },
  // vttest 2: screen features — ED 2 erases the whole screen.
  {
    name: "ED 2 erases all",
    prep: FIVES,
    seq: "\x1b[2J",
    rows: ["", "", "", "", ""],
  },
  // vttest 8: VT102 insert/delete — IL opens blank lines at the cursor row; lines below shift
  // down and the bottom ones fall off the screen.
  {
    name: "IL 2 inserts blank lines",
    prep: LETTERS,
    seq: "\x1b[2;1H\x1b[2L",
    rows: ["aa", "", "", "bb", "cc"],
  },
  // vttest 8: VT102 insert/delete — DL deletes lines at the cursor row; lines below shift up and
  // blanks appear at the bottom.
  {
    name: "DL 2 deletes lines",
    prep: LETTERS,
    seq: "\x1b[2;1H\x1b[2M",
    rows: ["aa", "dd", "ee", "", ""],
  },
];

describe("conformance: erase and edit", () => {
  it.each(LINE_EDITS)("$name", async ({ prep, seq, want }) => {
    const term = openTerm();
    await feed(term, prep + seq);
    expect(line(term, 0)).toBe(want);
  });

  it.each(GRID_EDITS)("$name", async ({ prep, seq, rows }) => {
    const term = openTerm({ rows: 5 });
    await feed(term, prep + seq);
    expect(rows.map((_, i) => line(term, i))).toEqual(rows);
  });

  // vttest 2: screen features — ED 2 clears content but does NOT move the cursor.
  it("ED 2 leaves the cursor in place", async () => {
    const term = openTerm({ rows: 5 });
    await feed(term, FIVES + "\x1b[2J");
    expect(cursor(term)).toEqual({ x: 5, y: 4 });
  });

  // vttest 8: VT102 insert/delete — ICH and ECH edit under a stationary cursor.
  it("ICH and ECH do not move the cursor", async () => {
    const t1 = openTerm();
    await feed(t1, "abcdef\x1b[1;3H\x1b[2@");
    expect(cursor(t1)).toEqual({ x: 2, y: 0 });
    const t2 = openTerm();
    await feed(t2, "abcdef\x1b[1;3H\x1b[2X");
    expect(cursor(t2)).toEqual({ x: 2, y: 0 });
  });

  // vttest 8: VT102 insert/delete — on a full row, ICH pushes the last column's cell off the
  // right edge; it is discarded, not wrapped.
  it("ICH on a full row discards the last column", async () => {
    const term = openTerm();
    const fill = "0123456789".repeat(8);
    await feed(term, fill + "\x1b[1;1H\x1b[1@");
    expect(line(term, 0)).toBe(" " + fill.slice(0, 79));
    expect(line(term, 1)).toBe("");
  });
});
