// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-65 (FR-1.3): behavior pins for the explicit scrollback cap and the viewport semantics around
// it, over a REAL emulator built from the production scrollback + emulation slices (the same
// build-from-the-slice discipline the trmx-64 conformance harness and oscIntegration regression
// use — a test-added option here would hide a production divergence).
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Terminal } from "@xterm/headless";
import { scrollbackTerminalOptions, SCROLLBACK_LINES } from "./scrollbackSettings";
import { emulationTerminalOptions } from "./emulationOptions";
import { computeScrollbar } from "./scrollbar";
import { makeSettingsStore, __resetSettingsForTest } from "../settings/settingsStore";

const ROWS = 24;

function feed(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** `count` numbered lines in one write (a joined string keeps the test fast at 10k+ lines). */
function lines(from: number, count: number): string {
  let out = "";
  for (let i = from; i < from + count; i++) out += `line-${i}\r\n`;
  return out;
}

describe("scrollback cap + viewport semantics (trmx-65)", () => {
  const terms: Terminal[] = [];
  beforeEach(() => {
    // trmx-80: the slice reads terminal.scrollbackLines from the shared snapshot; an empty
    // snapshot serves the registry default (= SCROLLBACK_LINES), which these cap tests pin.
    __resetSettingsForTest();
  });
  afterEach(() => {
    while (terms.length) terms.pop()?.dispose();
  });

  function openTerm(): Terminal {
    const term = new Terminal({
      ...scrollbackTerminalOptions(makeSettingsStore()),
      ...emulationTerminalOptions(),
      cols: 80,
      rows: ROWS,
    });
    terms.push(term);
    return term;
  }

  it("honors the cap: buffer never exceeds SCROLLBACK_LINES + rows, oldest lines evict first", async () => {
    const term = openTerm();
    const total = SCROLLBACK_LINES + ROWS + 500;
    await feed(term, lines(0, total));
    const buf = term.buffer.active;
    expect(buf.length).toBe(SCROLLBACK_LINES + ROWS);
    // Oldest 500+ evicted: the first retained buffer line is NOT line-0.
    const first = buf.getLine(0)?.translateToString(true) ?? "";
    expect(first).not.toBe("line-0");
    expect(first).toMatch(/^line-\d+$/);
  });

  it("bottom-pinned viewport FOLLOWS streaming output THROUGH cap eviction (viewportY tracks baseY)", async () => {
    // Per the frozen plan (V4g): the stream must CROSS the scrollback threshold while pinned, so
    // the pin is proven through eviction, not just ordinary growth.
    const term = openTerm();
    const seed = SCROLLBACK_LINES + ROWS - 100; // just below the cap
    await feed(term, lines(0, seed));
    const buf = term.buffer.active;
    expect(buf.viewportY).toBe(buf.baseY); // at the live bottom
    const baseBefore = buf.baseY;
    await feed(term, lines(seed, 400)); // crosses the cap: eviction starts underneath
    expect(buf.length).toBe(SCROLLBACK_LINES + ROWS); // capped
    expect(buf.baseY).toBeGreaterThan(baseBefore); // advanced to the cap ceiling
    expect(buf.baseY).toBe(SCROLLBACK_LINES);
    expect(buf.viewportY).toBe(buf.baseY); // STILL pinned after evicting output
    const first = buf.getLine(0)?.translateToString(true) ?? "";
    expect(first).not.toBe("line-0"); // oldest lines really evicted while pinned
  });

  it("a scrolled-back viewport is NOT yanked by new output; scrollToBottom re-pins", async () => {
    const term = openTerm();
    await feed(term, lines(0, 200));
    term.scrollLines(-50);
    const buf = term.buffer.active;
    const held = buf.viewportY;
    expect(held).toBeLessThan(buf.baseY);
    await feed(term, lines(200, 50));
    expect(buf.viewportY).toBe(held); // held position, no yank
    term.scrollToBottom();
    expect(buf.viewportY).toBe(buf.baseY);
  });

  it("alt-screen round trip preserves the normal buffer's scrollback", async () => {
    const term = openTerm();
    await feed(term, lines(0, 300));
    const lenBefore = term.buffer.active.length;
    await feed(term, "\x1b[?1049h"); // enter alt
    expect(term.buffer.active.type).toBe("alternate");
    await feed(term, "full-screen app output\r\n");
    await feed(term, "\x1b[?1049l"); // exit alt
    expect(term.buffer.active.type).toBe("normal");
    expect(term.buffer.active.length).toBe(lenBefore);
  });

  it("at-cap eviction under a scrolled-back viewport stays sane and yields valid scrollbar geometry", async () => {
    const term = openTerm();
    await feed(term, lines(0, SCROLLBACK_LINES + ROWS)); // buffer exactly at cap
    term.scrollLines(-100);
    const buf = term.buffer.active;
    await feed(term, lines(SCROLLBACK_LINES + ROWS, 300)); // 300 more lines evict underneath
    // Invariants: viewport stays within [0, baseY]; buffer stays at the cap.
    expect(buf.length).toBe(SCROLLBACK_LINES + ROWS);
    expect(buf.viewportY).toBeGreaterThanOrEqual(0);
    expect(buf.viewportY).toBeLessThanOrEqual(buf.baseY);
    // The trmx-41 pure geometry stays valid over this state (visible thumb, clamped, finite).
    const geo = computeScrollbar({
      rows: ROWS,
      cols: 80,
      viewportY: buf.viewportY,
      baseY: buf.baseY,
      length: buf.length,
      isAltBuffer: buf.type === "alternate",
      hostWidthPx: 640,
      hostHeightPx: 384,
      hovering: false,
    });
    expect(geo.visible).toBe(true); // scrolled back on the normal buffer with history
    if (geo.visible) {
      expect(geo.thumbHeightPx).toBeGreaterThan(0);
      expect(geo.thumbTopPx).toBeGreaterThanOrEqual(geo.trackTopPx);
      expect(geo.thumbTopPx + geo.thumbHeightPx).toBeLessThanOrEqual(
        geo.trackTopPx + geo.trackHeightPx + 1e-6,
      );
    }
  });

  it("typing snaps a scrolled-back viewport to the bottom (scrollOnUserInput default)", async () => {
    const term = openTerm();
    await feed(term, lines(0, 200));
    term.scrollLines(-50);
    const buf = term.buffer.active;
    expect(buf.viewportY).toBeLessThan(buf.baseY);
    term.input("x"); // user keystroke through the public input API
    expect(buf.viewportY).toBe(buf.baseY);
  });
});
