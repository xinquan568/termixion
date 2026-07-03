// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (FR-2, group 6): bracketed-paste conformance. The emulator-owned seam is DECSET/DECRST
// 2004 flipping `modes.bracketedPasteMode` (public API); the paste transform itself (LF→CR, then
// the 200~/201~ envelope exactly when the mode is on) is browser-side in production, so the driver
// ports it verbatim keyed off that REAL mode state (see driver.ts / README.md — headless ships no
// `paste()`). Each case cites its esctest analog.
import { describe, it, expect } from "vitest";
import { openTerm, feed, line, cursor, captureData, paste } from "./driver";

describe("conformance: bracketed paste", () => {
  // esctest: DECSET 2004 bracketed paste — the mode flag flips on and off.
  it("DECSET/DECRST 2004 flip bracketedPasteMode", async () => {
    const term = openTerm();
    expect(term.modes.bracketedPasteMode).toBe(false);
    await feed(term, "\x1b[?2004h");
    expect(term.modes.bracketedPasteMode).toBe(true);
    await feed(term, "\x1b[?2004l");
    expect(term.modes.bracketedPasteMode).toBe(false);
  });

  // esctest: DECSET 2004 bracketed paste — with the mode on, pasted text reaches the host wrapped
  // in ESC[200~ / ESC[201~ with the interior LF normalized to CR.
  it("paste while 2004 is set emits the bracket envelope", async () => {
    const term = openTerm();
    const data = captureData(term);
    await feed(term, "\x1b[?2004h");
    paste(term, "a\nb");
    expect(data).toEqual(["\x1b[200~a\rb\x1b[201~"]);
  });

  // esctest: DECRST 2004 — after reset the same paste goes out bare: LF still normalized to CR,
  // no envelope.
  it("paste after 2004 reset emits bare CR-normalized text", async () => {
    const term = openTerm();
    const data = captureData(term);
    await feed(term, "\x1b[?2004h\x1b[?2004l");
    paste(term, "a\nb");
    expect(data).toEqual(["a\rb"]);
  });

  // esctest: bracketed paste normalization — CRLF collapses to a single CR (not CR CR).
  it("paste normalizes CRLF to a single CR", async () => {
    const term = openTerm();
    const data = captureData(term);
    paste(term, "a\r\nb");
    expect(data).toEqual(["a\rb"]);
  });

  // esctest: bracketed paste — a multi-line paste never wraps rows by itself: paste is data OUT
  // to the host (onData), not input INTO the screen, so the buffer stays blank and the cursor
  // does not move until the host echoes something back.
  it("paste emits to the host without touching the screen", async () => {
    const term = openTerm();
    const data = captureData(term);
    await feed(term, "\x1b[?2004h");
    paste(term, "one\ntwo\nthree");
    expect(data).toEqual(["\x1b[200~one\rtwo\rthree\x1b[201~"]);
    expect(line(term, 0)).toBe("");
    expect(line(term, 1)).toBe("");
    expect(cursor(term)).toEqual({ x: 0, y: 0 });
  });
});
