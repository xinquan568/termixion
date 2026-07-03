// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (FR-1.2): the EMULATION-SEMANTICS option slice — the xterm options that decide whether
// Termixion behaves like a correct VT terminal, as opposed to how it looks (iterm2Theme.ts) or what
// the user configured (cursorSettings.ts / themeSettings.ts). This slice is exported on its own so
// the VT-conformance harness (app/src/conformance/) can construct its headless terminal from the
// EXACT configuration production uses — the harness pins Termixion's configured emulator, not bare
// xterm defaults. Pure record: no xterm/React/DOM runtime import, unit-testable headless.
import type { ITerminalOptions } from "@xterm/xterm";

/**
 * Options that alter VT semantics, fed to `new Terminal(...)` at the `realDeps.createTerminal`
 * chokepoint (TerminalView.tsx) and to the conformance driver.
 *
 * - `convertEol: false` — a PTY-backed terminal must not rewrite LF into CR+LF inside the emulator.
 *   In cooked mode the tty line discipline (ONLCR) already performs that conversion; in raw mode
 *   (vim, vttest, full-screen TUIs) a bare LF means "index down, KEEP the column" per VT semantics,
 *   and rewriting it corrupts cursor motion. `true` was a leftover from the pre-PTY demo phase
 *   (B-4, before C-2 wired the real shell); the conformance harness pins the corrected behavior
 *   (cursor-controls group, "LF keeps column").
 */
export function emulationTerminalOptions(): ITerminalOptions {
  return {
    convertEol: false,
  };
}
