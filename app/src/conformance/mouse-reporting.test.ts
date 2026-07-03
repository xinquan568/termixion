// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (FR-2, group 7): mouse-reporting conformance, tiered by what runs headless (README.md
// "Tiers"). Mode acceptance is fully public API (`modes.mouseTrackingMode`). Report ENCODING is
// assertable because the pinned 5.5.0 headless bundle ships the common-code CoreMouseService with
// `triggerMouseEvent` reachable (driver `mouseService()` — internal seam, guarded by an existence
// assertion so an upstream rename fails loudly). What headless can NOT exercise — real DOM events,
// pixel→cell translation, wheel and modifier handling — is `it.skip`ped here and covered by the
// packaged manual checklist. Each case cites its vttest menu item / esctest analog.
import { describe, it, expect } from "vitest";
import { openTerm, feed, line, captureData, captureBinary, mouseService } from "./driver";

describe("conformance: mouse reporting", () => {
  // vttest 11.2 (xterm mouse) / esctest: DECSET 9/1000/1002/1003 — each tracking mode is accepted
  // and reported back through the public modes API, and its DECRST returns to 'none'.
  const MODES = [
    { name: "DECSET 9 selects x10 tracking", set: "\x1b[?9h", reset: "\x1b[?9l", mode: "x10" },
    { name: "DECSET 1000 selects vt200 tracking", set: "\x1b[?1000h", reset: "\x1b[?1000l", mode: "vt200" },
    { name: "DECSET 1002 selects drag tracking", set: "\x1b[?1002h", reset: "\x1b[?1002l", mode: "drag" },
    { name: "DECSET 1003 selects any-motion tracking", set: "\x1b[?1003h", reset: "\x1b[?1003l", mode: "any" },
  ] as const;

  it.each(MODES)("$name", async ({ set, reset, mode }) => {
    const term = openTerm();
    expect(term.modes.mouseTrackingMode).toBe("none");
    await feed(term, set);
    expect(term.modes.mouseTrackingMode).toBe(mode);
    await feed(term, reset);
    expect(term.modes.mouseTrackingMode).toBe("none");
  });

  // esctest: DECSET 1006 (SGR extended coordinates) — the encoding switch is accepted without
  // error in both directions; the parser keeps rendering afterwards.
  it("DECSET/DECRST 1006 are accepted without error", async () => {
    const term = openTerm();
    await feed(term, "\x1b[?1006h\x1b[?1006l\x1b[?1006hok");
    expect(line(term, 0)).toBe("ok");
  });

  // esctest: SGR mouse encoding — press at 0-based cell (col 4, row 2) reports 1-based
  // `ESC[<0;5;3M`; release reports the same coordinates with a trailing 'm'.
  it("SGR encoding: press M / release m with 1-based coords", async () => {
    const term = openTerm();
    const data = captureData(term);
    await feed(term, "\x1b[?1000h\x1b[?1006h");
    const svc = mouseService(term);
    expect(svc).toBeDefined();
    expect(svc!.triggerMouseEvent({ col: 4, row: 2, button: 0, action: 1 })).toBe(true);
    expect(svc!.triggerMouseEvent({ col: 4, row: 2, button: 0, action: 0 })).toBe(true);
    expect(data).toEqual(["\x1b[<0;5;3M", "\x1b[<0;5;3m"]);
  });

  // esctest: DECSET 1002 + 1006 — a drag reports press, motion with the +32 motion flag on the
  // button code, then release at the final cell.
  it("SGR encoding: drag reports motion with the +32 flag", async () => {
    const term = openTerm();
    const data = captureData(term);
    await feed(term, "\x1b[?1002h\x1b[?1006h");
    const svc = mouseService(term);
    expect(svc).toBeDefined();
    svc!.triggerMouseEvent({ col: 4, row: 2, button: 0, action: 1 });
    svc!.triggerMouseEvent({ col: 6, row: 2, button: 0, action: 32 });
    svc!.triggerMouseEvent({ col: 6, row: 2, button: 0, action: 0 });
    expect(data).toEqual(["\x1b[<0;5;3M", "\x1b[<32;7;3M", "\x1b[<0;7;3m"]);
  });

  // vttest 11.2 (xterm mouse) — with NO tracking mode set, events are rejected and nothing is
  // emitted on either channel.
  it("no tracking mode: events are rejected, nothing emitted", async () => {
    const term = openTerm();
    const data = captureData(term);
    const binary = captureBinary(term);
    const svc = mouseService(term);
    expect(svc).toBeDefined();
    expect(svc!.triggerMouseEvent({ col: 4, row: 2, button: 0, action: 1 })).toBe(false);
    expect(data).toEqual([]);
    expect(binary).toEqual([]);
  });

  // vttest 11.2 (xterm mouse) — without DECSET 1006 the legacy X10 byte encoding applies
  // (32+code bytes); xterm.js routes that binary-unsafe report through onBinary, not onData.
  it("legacy encoding: X10 bytes travel the binary channel", async () => {
    const term = openTerm();
    const data = captureData(term);
    const binary = captureBinary(term);
    await feed(term, "\x1b[?1000h");
    const svc = mouseService(term);
    expect(svc).toBeDefined();
    expect(svc!.triggerMouseEvent({ col: 4, row: 2, button: 0, action: 1 })).toBe(true);
    expect(data).toEqual([]);
    expect(binary).toEqual(["\x1b[M %#"]);
  });

  // Deferred to the packaged manual checklist (README.md "Tiers"): translating REAL pointer input
  // — DOM mouse events, pixel→cell coordinate mapping — has no headless ingress (no DOM).
  it.skip("DOM pointer events translate to cell coordinates (manual checklist)", () => {
    // Exercised manually: click/drag in the packaged app over `printf '\x1b[?1000h\x1b[?1006h'`.
  });

  // Deferred to the packaged manual checklist (README.md "Tiers"): wheel reports (buttons 64/65)
  // and shift/alt/ctrl modifier flags are produced by the browser input layer from real events.
  it.skip("wheel and modifier-key reports from real events (manual checklist)", () => {
    // Exercised manually: scroll and modifier-click in the packaged app with SGR tracking on.
  });
});
