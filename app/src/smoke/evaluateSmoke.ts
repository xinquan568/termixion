// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// C-3: the end-to-end smoke assertion (P0-4 / Q2 / F2), evaluated over the accumulated terminal output
// produced by driving `pwd` / `cd "$DIR"` / `pwd` / `ls` through the production channel. Pure so the
// pass/fail logic is unit-tested; the run that produces the output needs the packaged app.

export interface SmokeResult {
  ok: boolean;
  reason: string;
}

/** Strip terminal control/escape sequences (a real shell's prompt + line editor emit many — colors,
 *  cursor moves, window-title OSC, bracketed-paste) so the command output can be matched as plain
 *  text; CR becomes a newline boundary (ZLE redraws lines with `\r`). The ESC/BEL bytes are built via
 *  String.fromCharCode so no control characters appear in the source. */
function stripControl(s: string): string {
  const esc = String.fromCharCode(27); // ESC (0x1b)
  const bel = String.fromCharCode(7); // BEL (0x07)
  return s
    .replace(new RegExp(esc + "\\][\\s\\S]*?" + bel, "g"), "") // OSC ... BEL (e.g. window title)
    .replace(new RegExp(esc + "\\[[0-9;?]*[ -/]*[@-~]", "g"), "") // CSI (color/cursor/bracketed-paste)
    .replace(new RegExp(esc + "[@-_]", "g"), "") // other 2-byte escapes
    .replace(/\r/g, "\n");
}

/**
 * Decide whether the smoke passed: (a) the second `pwd` printed `$DIR` on its own line — i.e. `cd`
 * took — and (b) `ls` listed the `SMOKE_OK` sentinel. Checking `$DIR` as a *whole trimmed line*
 * ignores the echoed `cd "$DIR"` command (which is `cd "<dir>"`, not `<dir>` alone).
 */
export function evaluateSmoke(output: string, dir: string): SmokeResult {
  const lines = stripControl(output).split("\n");
  // Match $DIR and SMOKE_OK as whole trimmed LINES (the pwd / ls output), not anywhere in the
  // transcript — so an echoed `cd "$DIR"`, a prompt, or a window title can't satisfy the assertion.
  const cwdBecameDir = lines.some((line) => line.trim() === dir);
  const listedSentinel = lines.some((line) => line.trim() === "SMOKE_OK");

  if (cwdBecameDir && listedSentinel) {
    return { ok: true, reason: `cwd became ${dir} and ls listed SMOKE_OK` };
  }

  const missing: string[] = [];
  if (!cwdBecameDir) missing.push(`pwd never printed ${dir} (cd did not take)`);
  if (!listedSentinel) missing.push("ls output did not list SMOKE_OK");
  return { ok: false, reason: missing.join("; ") };
}
