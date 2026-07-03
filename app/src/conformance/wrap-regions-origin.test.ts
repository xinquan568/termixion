// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (FR-2, group 3): autowrap, scroll regions, and origin mode — the geometry rules
// full-screen TUIs live and die by. Covers DECAWM on/off, the wrap-pending last-column quirk
// (writing the 80th column leaves the cursor logically past it; the NEXT printable wraps),
// DECSTBM region scrolling in both directions with rows outside the region untouched, and DECOM
// region-relative addressing with clamping. Each case cites its vttest menu item / esctest analog.
import { describe, it, expect } from "vitest";
import type { Terminal } from "@xterm/headless";
import { openTerm, feed, line, cellAt, cursor } from "./driver";

const FILL80 = "0123456789".repeat(8);

/** Feed rows L1..L10 into a 10-row screen (no trailing newline, so nothing scrolls). */
async function tenRows(term: Terminal) {
  for (let i = 1; i <= 10; i++) {
    await feed(term, `L${i}` + (i < 10 ? "\r\n" : ""));
  }
}

describe("conformance: wrap, regions, origin", () => {
  // vttest 1: cursor movements (autowrap) — after exactly 80 printables the cursor sits in the
  // wrap-PENDING state: cursorX reads 80 (past the last column), still on row 0. The wrap happens
  // only when the next printable arrives.
  it("DECAWM wrap-pending: 80th column does not wrap yet", async () => {
    const term = openTerm();
    await feed(term, FILL80);
    expect(cursor(term)).toEqual({ x: 80, y: 0 });
    expect(cellAt(term, 0, 79).text).toBe("9");
    expect(line(term, 1)).toBe("");
  });

  // vttest 1: cursor movements (autowrap) — the 81st printable resolves the pending wrap onto
  // row 1 column 1.
  it("DECAWM wraps on the character after the last column", async () => {
    const term = openTerm();
    await feed(term, FILL80 + "y");
    expect(cursor(term)).toEqual({ x: 1, y: 1 });
    expect(line(term, 1)).toBe("y");
  });

  // esctest: DECRST 7 (DECAWM off) — overflow characters overwrite the last column instead of
  // wrapping; row 1 stays empty and the public mode flag reads false.
  it("DECAWM off overwrites the last column", async () => {
    const term = openTerm();
    await feed(term, "\x1b[?7l" + FILL80 + "ABC");
    expect(term.modes.wraparoundMode).toBe(false);
    expect(line(term, 0)).toBe(FILL80.slice(0, 79) + "C");
    expect(line(term, 1)).toBe("");
    expect(cursor(term)).toEqual({ x: 80, y: 0 });
  });

  // esctest: DECSET 7 (DECAWM on) — the default; re-enabling after DECRST restores wrapping.
  it("DECAWM defaults on and re-enables after off", async () => {
    const term = openTerm();
    expect(term.modes.wraparoundMode).toBe(true);
    await feed(term, "\x1b[?7l\x1b[?7h" + FILL80 + "y");
    expect(term.modes.wraparoundMode).toBe(true);
    expect(cursor(term)).toEqual({ x: 1, y: 1 });
  });

  // vttest 2: screen features (scrolling region) — DECSTBM homes the cursor, and LF at the region
  // bottom scrolls ONLY rows 3..6: L3 leaves the region, a blank enters at row 6, rows above and
  // below the region are untouched, and NOTHING enters the scrollback (baseY stays 0).
  it("DECSTBM: LF at region bottom scrolls only the region", async () => {
    const term = openTerm({ rows: 10 });
    await tenRows(term);
    await feed(term, "\x1b[3;6r");
    expect(cursor(term)).toEqual({ x: 0, y: 0 });
    await feed(term, "\x1b[6;1H\n");
    const rows = Array.from({ length: 10 }, (_, i) => line(term, i));
    expect(rows).toEqual(["L1", "L2", "L4", "L5", "L6", "", "L7", "L8", "L9", "L10"]);
    expect(term.buffer.active.baseY).toBe(0);
    expect(cursor(term)).toEqual({ x: 0, y: 5 });
  });

  // vttest 2: screen features (scrolling region) — RI at the region TOP scrolls the region down:
  // a blank enters at row 3, L6 falls off the region bottom, outside rows untouched.
  it("DECSTBM: RI at region top scrolls the region down", async () => {
    const term = openTerm({ rows: 10 });
    await tenRows(term);
    await feed(term, "\x1b[3;6r\x1b[3;1H\x1bM");
    const rows = Array.from({ length: 10 }, (_, i) => line(term, i));
    expect(rows).toEqual(["L1", "L2", "", "L3", "L4", "L5", "L7", "L8", "L9", "L10"]);
    expect(cursor(term)).toEqual({ x: 0, y: 2 });
  });

  // vttest 2: screen features (scrolling region) — CSI r without params resets the region to the
  // full screen: LF at the true bottom scrolls everything into scrollback again.
  it("DECSTBM reset restores full-screen scrolling", async () => {
    const term = openTerm({ rows: 5 });
    await feed(term, "AAA\x1b[2;4r\x1b[r\x1b[5;1H\n");
    expect(term.buffer.active.baseY).toBe(1);
    expect(line(term, 0)).toBe("AAA");
  });

  // vttest 2: screen features (origin mode) / esctest: DECSET 6 — with DECOM on, the cursor homes
  // to the region's top-left and CUP addresses RELATIVE to the region: 2;5 lands on screen row 4.
  it("DECOM: CUP addresses relative to the region", async () => {
    const term = openTerm({ rows: 10 });
    await feed(term, "\x1b[3;6r\x1b[?6h");
    expect(term.modes.originMode).toBe(true);
    expect(cursor(term)).toEqual({ x: 0, y: 2 });
    await feed(term, "\x1b[2;5H");
    expect(cursor(term)).toEqual({ x: 4, y: 3 });
  });

  // esctest: DECOM — addressing past the region bottom clamps INSIDE the region, not the screen.
  it("DECOM: CUP clamps to the region bottom", async () => {
    const term = openTerm({ rows: 10 });
    await feed(term, "\x1b[3;6r\x1b[?6h\x1b[99;1H");
    expect(cursor(term)).toEqual({ x: 0, y: 5 });
  });

  // esctest: DECRST 6 — with DECOM off again, CUP is absolute even while the region persists.
  it("DECOM off restores absolute addressing", async () => {
    const term = openTerm({ rows: 10 });
    await feed(term, "\x1b[3;6r\x1b[?6h\x1b[?6l\x1b[2;5H");
    expect(term.modes.originMode).toBe(false);
    expect(cursor(term)).toEqual({ x: 4, y: 1 });
  });
});
