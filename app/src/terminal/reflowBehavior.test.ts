// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-67 (FR-1.6): behavior pins for resize/reflow — lossless rewrap of soft-wrapped history and
// stable viewport across column changes — over a REAL emulator built from the production scrollback
// + emulation slices (the same build-from-the-slice discipline scrollbackBehavior.test.ts / trmx-65
// uses — a test-added option would hide a production divergence).
//
// Probe verdict (@xterm/headless 5.5.0): the headless build DOES reflow on `term.resize()` —
// `Buffer._isReflowEnabled` holds whenever scrollback > 0 and windowsMode is off, both true under
// the production slices — with ONE deliberate carve-out: xterm SKIPS the logical line holding the
// cursor (reflowSmaller/reflowLarger bail on it; the program owning the prompt is expected to
// redraw it after SIGWINCH). These tests therefore park the cursor on a short prompt line below
// the content under test, and pin the carve-out itself explicitly. The half of the acceptance the
// emulator delegates to the shell — the prompt line re-rendering after a resize — is not
// observable headless and lives in the e2e/manual tier.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Terminal } from "@xterm/headless";
import { scrollbackTerminalOptions, SCROLLBACK_LINES } from "./scrollbackSettings";
import { emulationTerminalOptions } from "./emulationOptions";
import { makeSettingsStore, __resetSettingsForTest } from "../settings/settingsStore";

const ROWS = 24;
const WIDE = 80;
const NARROW = 40;

function feed(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** A deterministic `len`-char line (a–z cycling, no spaces) that soft-wraps without trimming. */
function longLine(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(97 + (i % 26));
  return out;
}

/** `count` wrap-eligible 60-char lines (52 fill chars + 8-digit id) in one write. */
function wrapLines(fill: string, count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(fill.repeat(52) + String(i).padStart(8, "0"));
  return parts.join("\r\n");
}

/** Re-join wrapped buffer rows into LOGICAL lines via isWrapped; trailing blank rows dropped. */
function logicalLines(term: Terminal): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) break;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
    else out.push(text);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

describe("resize reflow + viewport stability (trmx-67)", () => {
  const terms: Terminal[] = [];
  beforeEach(() => {
    // trmx-80: the slice reads terminal.scrollbackLines from the shared snapshot; an empty
    // snapshot serves the registry default (= SCROLLBACK_LINES), which the at-cap test pins.
    __resetSettingsForTest();
  });
  afterEach(() => {
    while (terms.length) terms.pop()?.dispose();
  });

  function openTerm(): Terminal {
    const term = new Terminal({
      ...scrollbackTerminalOptions(makeSettingsStore()),
      ...emulationTerminalOptions(),
      cols: WIDE,
      rows: ROWS,
    });
    terms.push(term);
    return term;
  }

  it("narrow→widen round trip rewraps a 200-char line losslessly (no truncation, no duplication)", async () => {
    const term = openTerm();
    const long = longLine(200);
    await feed(term, long + "\r\n$ "); // prompt below keeps the cursor OFF the line under test
    const buf = term.buffer.active;
    // 80 cols: 200 chars soft-wrap to ceil(200/80) = 3 rows.
    expect(buf.getLine(1)?.isWrapped).toBe(true);
    expect(buf.getLine(2)?.isWrapped).toBe(true);
    expect(logicalLines(term)).toEqual([long, "$ "]);

    term.resize(NARROW, ROWS);
    // 40 cols: the same logical content across ceil(200/40) = 5 rows; the re-join is EXACT, so
    // nothing was truncated and nothing was duplicated.
    for (let i = 1; i <= 4; i++) expect(buf.getLine(i)?.isWrapped).toBe(true);
    expect(buf.getLine(5)?.isWrapped).toBe(false);
    expect(logicalLines(term)).toEqual([long, "$ "]);

    term.resize(WIDE, ROWS);
    // Widen back: the wrapped rows merge again (3 rows) and the content is still exact.
    expect(buf.getLine(1)?.isWrapped).toBe(true);
    expect(buf.getLine(2)?.isWrapped).toBe(true);
    expect(buf.getLine(3)?.isWrapped).toBe(false);
    expect(logicalLines(term)).toEqual([long, "$ "]);
  });

  it("shrink keeps the last logical line last and the cursor on it (prompt integrity)", async () => {
    const term = openTerm();
    const prompt = "$ typed-command";
    await feed(term, "alpha-one two three\r\nbravo-line\r\n" + prompt);
    const buf = term.buffer.active;
    term.resize(NARROW, ROWS);
    const logical = logicalLines(term);
    expect(logical[logical.length - 1]).toBe(prompt);
    // The cursor still sits ON that line, same column (every line here fits in 40 cols).
    expect(buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true)).toBe(prompt);
    expect(buf.cursorX).toBe(prompt.length);
  });

  it("carve-out: the cursor's own over-width line truncates instead of rewrapping", async () => {
    // xterm's reflow deliberately skips the cursor's logical line — after a real resize the shell
    // redraws the prompt on SIGWINCH. That redraw is the e2e/manual tier; headless pins the
    // emulator's half: deterministic truncation to the new width, cursor clamped into the grid.
    const term = openTerm();
    await feed(term, "first-line\r\n$ " + "z".repeat(60)); // 62-char cursor line
    const buf = term.buffer.active;
    term.resize(NARROW, ROWS);
    const cursorRow = buf.baseY + buf.cursorY;
    expect(buf.getLine(cursorRow)?.translateToString(true)).toBe("$ " + "z".repeat(38));
    expect(buf.getLine(cursorRow + 1)?.isWrapped).toBe(false); // no continuation row created
    expect(buf.getLine(cursorRow + 1)?.translateToString(true)).toBe("");
    expect(buf.cursorX).toBe(NARROW - 1);
  });

  it("at-cap shrink: wrap inflation evicts at the cap — length ≤ SCROLLBACK_LINES + rows, still pinned", async () => {
    const term = openTerm();
    // Exactly cap + rows logical lines: (cap + rows − 1) 60-char lines + the prompt. Every content
    // line rewraps to 2 rows at 40 cols, so the shrink would double the count without the cap.
    const content = SCROLLBACK_LINES + ROWS - 1;
    await feed(term, wrapLines("x", content) + "\r\n$ ");
    const buf = term.buffer.active;
    expect(buf.length).toBe(SCROLLBACK_LINES + ROWS); // at the cap before the resize
    term.resize(NARROW, ROWS);
    expect(buf.length).toBe(SCROLLBACK_LINES + ROWS); // inflation absorbed by eviction, never > cap + rows
    expect(buf.baseY).toBe(SCROLLBACK_LINES);
    expect(buf.viewportY).toBe(buf.baseY); // still bottom-pinned
    // The newest content survived — eviction took the oldest: prompt still last, and the final
    // content line re-joins to its full 60 chars (rewrap, not truncation, at the cap).
    const logical = logicalLines(term);
    expect(logical[logical.length - 1]).toBe("$ ");
    expect(logical[logical.length - 2]).toBe("x".repeat(52) + String(content - 1).padStart(8, "0"));
  });

  it("alt-screen: a resize inside 1049 never leaks alt content into the normal buffer", async () => {
    const term = openTerm();
    await feed(term, longLine(200) + "\r\nnormal-B\r\n$ ");
    const before = logicalLines(term);
    await feed(term, "\x1b[?1049h"); // enter alt
    expect(term.buffer.active.type).toBe("alternate");
    await feed(term, "ALT-STUFF-1\r\nALT-STUFF-2");
    term.resize(NARROW, ROWS); // resize WHILE the alt screen is active
    await feed(term, "\x1b[?1049l"); // exit alt
    const buf = term.buffer.active;
    expect(buf.type).toBe("normal");
    // Logical content identical to before the alt round trip — the 40-col reflow changed only the
    // row layout of the pre-existing content, and none of the alt output was rewrapped into it.
    expect(logicalLines(term)).toEqual(before);
    for (let i = 0; i < buf.length; i++) {
      expect(buf.getLine(i)?.translateToString(true) ?? "").not.toContain("ALT-STUFF");
    }
  });

  it("bottom-pinned viewport stays pinned through a reflow-inflating shrink (viewportY tracks baseY)", async () => {
    const term = openTerm();
    await feed(term, wrapLines("y", 200) + "\r\n$ ");
    const buf = term.buffer.active;
    expect(buf.viewportY).toBe(buf.baseY); // pinned before
    const baseBefore = buf.baseY;
    term.resize(NARROW, ROWS);
    expect(buf.baseY).toBeGreaterThan(baseBefore); // the rewrap really inflated the buffer
    expect(buf.viewportY).toBe(buf.baseY); // STILL pinned after the reflow
  });

  it("a scrolled-back viewport does NOT snap to bottom on resize", async () => {
    const term = openTerm();
    await feed(term, wrapLines("y", 200) + "\r\n$ ");
    term.scrollLines(-50);
    const buf = term.buffer.active;
    expect(buf.viewportY).toBeLessThan(buf.baseY);
    term.resize(NARROW, ROWS);
    expect(buf.viewportY).toBeLessThan(buf.baseY); // held off the bottom — no yank
    expect(buf.viewportY).toBeGreaterThanOrEqual(0); // and still inside the valid range
  });
});
