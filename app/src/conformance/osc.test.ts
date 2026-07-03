// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (FR-2, group 9): OSC conformance — title changes (OSC 0/2) fire onTitleChange with the
// exact payload under BOTH terminators (BEL and ST), unknown OSC codes are consumed without
// corrupting the stream, and OSC 8 hyperlinks parse with their text rendering normally. Link-RANGE
// introspection is not exposed by the headless build (link providers are browser API), so the
// hyperlink cases pin parse-safety + rendering; pointer behavior is on the packaged manual
// checklist (README.md). Cases cite xterm ctlseqs (OSC has no vttest menu) / esctest analogs.
import { describe, it, expect } from "vitest";
import { openTerm, feed, line, captureTitles } from "./driver";

describe("conformance: OSC", () => {
  // xterm ctlseqs OSC 0/2 (esctest: ChangeWindowTitle) — both title codes, each under both
  // terminators; the payload arrives verbatim.
  const TITLES = [
    { name: "OSC 0 + BEL fires the title", seq: "\x1b]0;icon+title BEL\x07", want: "icon+title BEL" },
    { name: "OSC 0 + ST fires the title", seq: "\x1b]0;icon+title ST\x1b\\", want: "icon+title ST" },
    { name: "OSC 2 + BEL fires the title", seq: "\x1b]2;title BEL\x07", want: "title BEL" },
    { name: "OSC 2 + ST fires the title", seq: "\x1b]2;title ST\x1b\\", want: "title ST" },
  ] as const;

  it.each(TITLES)("$name", async ({ seq, want }) => {
    const term = openTerm();
    const titles = captureTitles(term);
    await feed(term, seq);
    expect(titles).toEqual([want]);
  });

  // xterm ctlseqs OSC — an unknown code (OSC 999) terminated by BEL is consumed whole: no title
  // event, no payload bytes leaking onto the screen, and parsing continues cleanly after it.
  it("unknown OSC + BEL is consumed safely", async () => {
    const term = openTerm();
    const titles = captureTitles(term);
    await feed(term, "\x1b]999;garbage-data\x07after");
    expect(titles).toEqual([]);
    expect(line(term, 0)).toBe("after");
  });

  // xterm ctlseqs OSC — the same unknown code terminated by ST is equally safe.
  it("unknown OSC + ST is consumed safely", async () => {
    const term = openTerm();
    const titles = captureTitles(term);
    await feed(term, "\x1b]999;zzz\x1b\\ok");
    expect(titles).toEqual([]);
    expect(line(term, 0)).toBe("ok");
  });

  // xterm ctlseqs OSC 8 (hyperlink) — open + close with BEL terminators parse without error and
  // the anchor text renders as plain cells.
  it("OSC 8 hyperlink open+close renders its text (BEL)", async () => {
    const term = openTerm();
    await feed(term, "\x1b]8;;https://example.com\x07link text\x1b]8;;\x07 plain");
    expect(line(term, 0)).toBe("link text plain");
  });

  // xterm ctlseqs OSC 8 (hyperlink) — the ST-terminated form with an id= parameter parses and
  // renders identically; text after the close is unlinked but visually seamless.
  it("OSC 8 hyperlink with id param renders its text (ST)", async () => {
    const term = openTerm();
    await feed(term, "\x1b]8;id=xyz;https://example.com/a\x1b\\IDLINK\x1b]8;;\x1b\\!");
    expect(line(term, 0)).toBe("IDLINK!");
  });
});
