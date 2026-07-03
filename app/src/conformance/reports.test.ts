// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (FR-2, group 8): device reports — the sequences a shell/TUI uses to interrogate the
// terminal, answered on the wire (onData). DA identity, operating-status DSR, and the cursor
// position report, which must reflect where the cursor ACTUALLY is. Each case cites its vttest
// menu item (vttest 6: terminal reports).
import { describe, it, expect } from "vitest";
import { openTerm, feed, captureData } from "./driver";

describe("conformance: device reports", () => {
  // vttest 6: terminal reports — DA1 (CSI c) answers with xterm.js's identity, "VT100 with
  // Advanced Video Option" (CSI ? 1 ; 2 c).
  it("DA1 reports the device attributes", async () => {
    const term = openTerm();
    const data = captureData(term);
    await feed(term, "\x1b[c");
    expect(data).toEqual(["\x1b[?1;2c"]);
  });

  // vttest 6: terminal reports — DA1 with the explicit default parameter 0 answers identically.
  it("DA1 with param 0 reports identically", async () => {
    const term = openTerm();
    const data = captureData(term);
    await feed(term, "\x1b[0c");
    expect(data).toEqual(["\x1b[?1;2c"]);
  });

  // vttest 6: terminal reports — DA2 (CSI > c) answers the secondary attributes: type 0,
  // firmware 276 (xterm.js's pinned xterm patch level), cartridge 0.
  it("DA2 reports the secondary device attributes", async () => {
    const term = openTerm();
    const data = captureData(term);
    await feed(term, "\x1b[>c");
    expect(data).toEqual(["\x1b[>0;276;0c"]);
  });

  // vttest 6: terminal reports — DSR 5 (operating status) answers "OK" (CSI 0 n).
  it("DSR 5 reports operating status OK", async () => {
    const term = openTerm();
    const data = captureData(term);
    await feed(term, "\x1b[5n");
    expect(data).toEqual(["\x1b[0n"]);
  });

  // vttest 6: terminal reports — CPR (DSR 6): park the cursor at 7;12 first; the report must
  // carry the ACTUAL 1-based position back.
  it("CPR reports the parked cursor position", async () => {
    const term = openTerm();
    const data = captureData(term);
    await feed(term, "\x1b[7;12H\x1b[6n");
    expect(data).toEqual(["\x1b[7;12R"]);
  });

  // vttest 6: terminal reports — CPR tracks movement: home and the bottom-right corner both
  // report exactly.
  it("CPR tracks the cursor to the screen corners", async () => {
    const term = openTerm();
    const data = captureData(term);
    await feed(term, "\x1b[H\x1b[6n\x1b[24;80H\x1b[6n");
    expect(data).toEqual(["\x1b[1;1R", "\x1b[24;80R"]);
  });
});
