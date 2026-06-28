// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// C-3 (test-first): the smoke assertion — pure, over the accumulated terminal output. The packaged
// `--smoke` run itself needs the Tauri runtime (validated by the built app / D-3), but the pass/fail
// decision is pure and unit-tested here.
import { describe, it, expect } from "vitest";
import { evaluateSmoke } from "./evaluateSmoke";

const DIR = "/private/tmp/x/termixion-smoke";

// What an interactive shell echoes for: pwd / cd "$DIR" / pwd / ls (with SMOKE_OK present) / marker.
const goodOutput = [
  "host% pwd",
  "/Users/me",
  `host% cd "${DIR}"`,
  "host% pwd",
  DIR, // the second pwd printed $DIR on its own line
  "host% ls",
  "SMOKE_OK",
  "host% echo __TXSMOKEDONE__",
  "__TXSMOKEDONE__",
].join("\r\n");

describe("evaluateSmoke", () => {
  it("passes when the cwd became $DIR and ls listed SMOKE_OK", () => {
    const r = evaluateSmoke(goodOutput, DIR);
    expect(r.ok).toBe(true);
  });

  it("fails when the cwd never became $DIR (cd didn't take)", () => {
    const out = goodOutput.replace(`\r\n${DIR}\r\n`, "\r\n/Users/me\r\n");
    const r = evaluateSmoke(out, DIR);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(DIR);
  });

  it("fails when ls did not list SMOKE_OK", () => {
    const out = goodOutput.replace("SMOKE_OK", "OTHER_FILE");
    const r = evaluateSmoke(out, DIR);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("SMOKE_OK");
  });

  it("does not mistake the echoed `cd \"$DIR\"` line for the pwd result", () => {
    // Output where $DIR appears ONLY inside the echoed `cd "$DIR"` command, never as a pwd line.
    const out = [`host% cd "${DIR}"`, "host% ls", "SMOKE_OK"].join("\r\n");
    expect(evaluateSmoke(out, DIR).ok).toBe(false);
  });

  it("strips ANSI/control sequences a real shell emits before matching", () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    // $DIR and SMOKE_OK wrapped in colors, a window-title OSC, a CR redraw, and bracketed-paste.
    const noisy =
      `${ESC}]2;some-title${BEL}` +
      `${ESC}[1m${ESC}[32m${DIR}${ESC}[0m\r\n` +
      `${ESC}[?2004h${ESC}[36mSMOKE_OK${ESC}[0m${ESC}[?2004l\r\n`;
    expect(evaluateSmoke(noisy, DIR).ok).toBe(true);
  });
});
