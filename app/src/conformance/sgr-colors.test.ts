// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (FR-2, group 4): SGR conformance — the 16 base colors map onto palette indices 0-15,
// 256-color and 24-bit truecolor land with EXACT values (cellAt exposes the raw 0xRRGGBB number),
// each text attribute sets independently, and SGR 0 wipes everything back to default. Each case
// cites its vttest menu item / esctest analog.
import { describe, it, expect } from "vitest";
import { openTerm, feed, cellAt } from "./driver";

describe("conformance: SGR colors and attributes", () => {
  // vttest 11 (xterm colors) / esctest: SGR 30-37 — the 8 base foregrounds are palette 0-7.
  it("SGR 30-37 map to fg palette 0-7", async () => {
    const term = openTerm();
    for (let i = 0; i < 8; i++) await feed(term, `\x1b[${30 + i}mX`);
    for (let i = 0; i < 8; i++) {
      const c = cellAt(term, 0, i);
      expect(c.fgMode).toBe("palette");
      expect(c.fg).toBe(i);
    }
  });

  // vttest 11 (xterm colors) / esctest: SGR 90-97 — the bright (aixterm) foregrounds are 8-15.
  it("SGR 90-97 map to fg palette 8-15", async () => {
    const term = openTerm();
    for (let i = 0; i < 8; i++) await feed(term, `\x1b[${90 + i}mX`);
    for (let i = 0; i < 8; i++) {
      const c = cellAt(term, 0, i);
      expect(c.fgMode).toBe("palette");
      expect(c.fg).toBe(8 + i);
    }
  });

  // vttest 11 (xterm colors) / esctest: SGR 40-47 — the 8 base backgrounds are palette 0-7.
  it("SGR 40-47 map to bg palette 0-7", async () => {
    const term = openTerm();
    for (let i = 0; i < 8; i++) await feed(term, `\x1b[${40 + i}mX`);
    for (let i = 0; i < 8; i++) {
      const c = cellAt(term, 0, i);
      expect(c.bgMode).toBe("palette");
      expect(c.bg).toBe(i);
    }
  });

  // vttest 11 (xterm colors) / esctest: SGR 100-107 — the bright backgrounds are 8-15.
  it("SGR 100-107 map to bg palette 8-15", async () => {
    const term = openTerm();
    for (let i = 0; i < 8; i++) await feed(term, `\x1b[${100 + i}mX`);
    for (let i = 0; i < 8; i++) {
      const c = cellAt(term, 0, i);
      expect(c.bgMode).toBe("palette");
      expect(c.bg).toBe(8 + i);
    }
  });

  // vttest 11 (xterm 88/256 colors) / esctest: SGR 38;5;N — indexed foreground keeps the exact
  // index across the palette (base, bright, cube, and grayscale entries).
  it("SGR 38;5;N selects the exact fg palette index", async () => {
    const term = openTerm();
    const indexes = [0, 15, 16, 123, 231, 255];
    for (const n of indexes) await feed(term, `\x1b[38;5;${n}mX`);
    indexes.forEach((n, col) => {
      const c = cellAt(term, 0, col);
      expect(c.fgMode).toBe("palette");
      expect(c.fg).toBe(n);
    });
  });

  // vttest 11 (xterm 88/256 colors) / esctest: SGR 48;5;N — indexed background.
  it("SGR 48;5;N selects the exact bg palette index", async () => {
    const term = openTerm();
    const indexes = [0, 15, 16, 123, 231, 255];
    for (const n of indexes) await feed(term, `\x1b[48;5;${n}mX`);
    indexes.forEach((n, col) => {
      const c = cellAt(term, 0, col);
      expect(c.bgMode).toBe("palette");
      expect(c.bg).toBe(n);
    });
  });

  // esctest: SGR 38;2;R;G;B (truecolor) — the exact 24-bit value round-trips: 12;34;56 is
  // 0x0c2238, and channel order is RRGGBB.
  it("SGR 38;2;R;G;B stores the exact fg RGB", async () => {
    const term = openTerm();
    await feed(term, "\x1b[38;2;12;34;56mX\x1b[38;2;255;0;0mY\x1b[38;2;0;0;1mZ");
    expect(cellAt(term, 0, 0)).toMatchObject({ fgMode: "rgb", fg: 0x0c2238 });
    expect(cellAt(term, 0, 1)).toMatchObject({ fgMode: "rgb", fg: 0xff0000 });
    expect(cellAt(term, 0, 2)).toMatchObject({ fgMode: "rgb", fg: 0x000001 });
  });

  // esctest: SGR 48;2;R;G;B (truecolor) — exact 24-bit background.
  it("SGR 48;2;R;G;B stores the exact bg RGB", async () => {
    const term = openTerm();
    await feed(term, "\x1b[48;2;255;0;128mX\x1b[48;2;1;2;3mY");
    expect(cellAt(term, 0, 0)).toMatchObject({ bgMode: "rgb", bg: 0xff0080 });
    expect(cellAt(term, 0, 1)).toMatchObject({ bgMode: "rgb", bg: 0x010203 });
  });

  // esctest: SGR 1/2/3/4/7/9 — each attribute independently, asserted against the full flag
  // set so a stray attribute shows up as a diff, not a silent pass.
  const ATTRS = [
    { name: "SGR 1 sets bold", code: 1, flag: "bold" },
    { name: "SGR 2 sets faint (dim)", code: 2, flag: "dim" },
    { name: "SGR 3 sets italic", code: 3, flag: "italic" },
    { name: "SGR 4 sets underline", code: 4, flag: "underline" },
    { name: "SGR 7 sets inverse", code: 7, flag: "inverse" },
    { name: "SGR 9 sets strikethrough", code: 9, flag: "strike" },
  ] as const;

  it.each(ATTRS)("$name", async ({ code, flag }) => {
    const term = openTerm();
    await feed(term, `\x1b[${code}mA`);
    const c = cellAt(term, 0, 0);
    const flags = {
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
      strike: false,
      [flag]: true,
    };
    expect(c).toMatchObject(flags);
  });

  // esctest: SGR 0 — reset clears every attribute AND both colors in one shot: cell A carries the
  // whole stack, cell B written right after SGR 0 is fully default. (Default-mode color numbers
  // read -1 in the 5.5.0 runtime — see CellSnapshot in driver.ts.)
  it("SGR 0 resets all attributes and colors", async () => {
    const term = openTerm();
    await feed(term, "\x1b[1;2;3;4;7;9;31;44mA\x1b[0mB");
    expect(cellAt(term, 0, 0)).toMatchObject({
      bold: true,
      dim: true,
      italic: true,
      underline: true,
      inverse: true,
      strike: true,
      fgMode: "palette",
      fg: 1,
      bgMode: "palette",
      bg: 4,
    });
    expect(cellAt(term, 0, 1)).toEqual({
      text: "B",
      fgMode: "default",
      fg: -1,
      bgMode: "default",
      bg: -1,
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
      strike: false,
    });
  });

  // esctest: SGR default state — an unstyled cell reads default/default with no flags.
  it("plain text renders with default colors and no attributes", async () => {
    const term = openTerm();
    await feed(term, "A");
    expect(cellAt(term, 0, 0)).toEqual({
      text: "A",
      fgMode: "default",
      fg: -1,
      bgMode: "default",
      bg: -1,
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
      strike: false,
    });
  });
});
