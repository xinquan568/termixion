// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-247: the slice of a mounted terminal that the IPC layer actually drives.
//
// `ipc/useBackend` used to import `TerminalHandle` from `terminal/mountTerminal` — the transport
// layer reaching UP into a feature directory, and the last `ipc -> terminal` edge. It does not need
// the whole handle: it writes PTY bytes, subscribes to keystrokes and resizes, and reads the grid
// size to open the session at the terminal's ACTUAL dimensions. That is this interface.
//
// `TerminalHandle` is structurally assignable to `TerminalPort`, so callers pass one unchanged —
// no adapter, no cast at the call site. Importing the full handle would have dragged `RendererKind`,
// `SearchLike`, `AddonLike`, `FitLike` and `SearchAddonLike` into `ipc/` for no reason.
export interface TerminalPort {
  terminal: {
    /** Write PTY output bytes. The callback is xterm's parse-completion signal (trmx-78 acks). */
    write(data: Uint8Array, callback?: () => void): void;
    /** Subscribe to user keystrokes (xterm delivers them as a string). */
    onData(handler: (data: string) => void): void;
    /** Subscribe to cell-grid resizes. */
    onResize(handler: (size: { rows: number; cols: number }) => void): void;
    /** trmx-67: the mounted grid size, when the implementation exposes it (real xterm does). */
    readonly rows?: number;
    readonly cols?: number;
  };
}
