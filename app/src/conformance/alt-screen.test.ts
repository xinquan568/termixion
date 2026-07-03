// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (FR-2, group 5): alternate-screen conformance — DECSET/DECRST 47, 1047, and 1049 (the
// smcup/rmcup trio). The load-bearing guarantees: the active buffer type flips and flips back,
// 1049 clears the alt screen on entry and restores the saved cursor on exit, the normal buffer's
// scrollback survives an alt round-trip untouched, and nothing written on the alt screen leaks
// into the normal buffer. Each case cites its esctest analog (vttest predates xterm's alt screen;
// the sequences are xterm ctlseqs).
import { describe, it, expect } from "vitest";
import { openTerm, feed, line, cursor } from "./driver";

describe("conformance: alternate screen", () => {
  // esctest: DECSET 47 — the original alt-screen switch flips the active buffer type.
  it("DECSET/DECRST 47 flip the active buffer", async () => {
    const term = openTerm({ rows: 5 });
    expect(term.buffer.active.type).toBe("normal");
    await feed(term, "\x1b[?47h");
    expect(term.buffer.active.type).toBe("alternate");
    await feed(term, "\x1b[?47l");
    expect(term.buffer.active.type).toBe("normal");
  });

  // esctest: DECSET 47 — switching away and back preserves the normal screen's content.
  it("normal content survives a 47 round-trip", async () => {
    const term = openTerm({ rows: 5 });
    await feed(term, "normal-text\x1b[?47h\x1b[?47l");
    expect(line(term, 0)).toBe("normal-text");
  });

  // esctest: DECSET 1047 — the clear-on-exit variant also flips the buffer type both ways.
  it("DECSET/DECRST 1047 flip the active buffer", async () => {
    const term = openTerm({ rows: 5 });
    await feed(term, "\x1b[?1047h");
    expect(term.buffer.active.type).toBe("alternate");
    await feed(term, "\x1b[?1047l");
    expect(term.buffer.active.type).toBe("normal");
  });

  // esctest: DECSET 1049 — entry clears the alt screen even when an earlier 47 session left junk
  // on it, so every 1049 application starts on a blank screen.
  it("1049 clears the alt screen on entry", async () => {
    const term = openTerm({ rows: 5 });
    await feed(term, "\x1b[?47hALT-JUNK\x1b[?47l\x1b[?1049h");
    expect(term.buffer.active.type).toBe("alternate");
    for (let i = 0; i < 5; i++) expect(line(term, i)).toBe("");
  });

  // esctest: DECSET 1049 — the save/restore contract: the cursor position at entry is restored on
  // exit no matter where the alt-screen application moved it.
  it("1049 saves and restores the cursor", async () => {
    const term = openTerm({ rows: 5 });
    await feed(term, "\x1b[4;10H");
    expect(cursor(term)).toEqual({ x: 9, y: 3 });
    await feed(term, "\x1b[?1049h\x1b[1;1Hmoved\x1b[?1049l");
    expect(term.buffer.active.type).toBe("normal");
    expect(cursor(term)).toEqual({ x: 9, y: 3 });
  });

  // esctest: DECSET 1049 — the alt buffer has NO scrollback (its length equals the row count),
  // and the normal buffer's scrollback is untouched by a full alt round-trip.
  it("scrollback is untouched by an alt round-trip", async () => {
    const term = openTerm({ rows: 5, scrollback: 100 });
    for (let i = 0; i < 20; i++) await feed(term, `line${i}\r\n`);
    const lengthBefore = term.buffer.normal.length;
    expect(lengthBefore).toBeGreaterThan(5);
    await feed(term, "\x1b[?1049h");
    expect(term.buffer.active.length).toBe(5);
    await feed(term, "scrolling\r\n".repeat(10));
    await feed(term, "\x1b[?1049l");
    expect(term.buffer.normal.length).toBe(lengthBefore);
  });

  // esctest: DECSET 1049 — content written on the alt screen must not leak into the normal
  // buffer (screen or scrollback) after exit.
  it("alt-screen content does not leak into the normal buffer", async () => {
    const term = openTerm({ rows: 5 });
    await feed(term, "before\x1b[?1049hALT-ONLY-MARKER\x1b[?1049lafter");
    expect(term.buffer.active.type).toBe("normal");
    const all = Array.from({ length: term.buffer.normal.length }, (_, i) =>
      line(term, i),
    ).join("\n");
    expect(all).not.toContain("ALT-ONLY-MARKER");
    expect(all).toContain("before");
  });

  // esctest: buffer namespaces — the public namespace always exposes both buffers with stable
  // types, whichever is active.
  it("buffer namespace exposes normal and alternate", async () => {
    const term = openTerm({ rows: 5 });
    expect(term.buffer.normal.type).toBe("normal");
    expect(term.buffer.alternate.type).toBe("alternate");
    await feed(term, "\x1b[?1049h");
    expect(term.buffer.normal.type).toBe("normal");
    expect(term.buffer.alternate.type).toBe("alternate");
  });
});
