// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (FR-2): the driver behind the curated VT-conformance harness. It boots `@xterm/headless`
// from `emulationTerminalOptions()` — the EXACT emulation-semantics slice production feeds into
// `new Terminal(...)` at the `realDeps.createTerminal` chokepoint — so every case in this directory
// pins *Termixion's configured emulator*, not bare xterm defaults. We do not fork or re-test
// xterm.js wholesale; we pin the sequences Termixion's users depend on (vttest / esctest analogs)
// against the configuration we actually ship, so an xterm upgrade or an option regression
// (e.g. the trmx-64 `convertEol` bug) turns a behavior change into a red test.
//
// Two gaps in the installed headless build (verified against
// app/node_modules/@xterm/headless/typings/xterm-headless.d.ts and the 5.5.0 runtime), and how the
// driver bridges them:
//
// - `paste()` is browser-only (`@xterm/xterm`); the headless Terminal does not expose it. The
//   `paste()` helper below ports the browser clipboard transform verbatim (xterm.js
//   src/browser/Clipboard.ts: `prepareTextForTerminal` LF→CR, then `bracketTextForPaste`) keyed off
//   the emulator's REAL `modes.bracketedPasteMode` state — so the DECSET 2004 parsing and mode
//   bookkeeping under test are genuine emulator behavior; only the wrap/normalize literals are
//   replicated. The browser `paste()` path itself is exercised by the packaged manual checklist.
// - Mouse reports have no public headless ingress (the browser layer translates DOM events into
//   core mouse events). The common-code encoder IS in the headless build, reachable as
//   `_core.coreMouseService.triggerMouseEvent` — internal but present un-mangled in the pinned
//   5.5.0 bundle. `mouseService()` exposes that seam with a narrow type so the SGR encoding can be
//   asserted headless; DOM-event→cell translation stays on the manual checklist (see README.md).
//
// Row addressing: `line()`/`cellAt()` take BUFFER-absolute rows (`buffer.active.getLine(row)`,
// scrollback included). Until output scrolls, buffer row == screen row (`baseY` is 0); the few
// cases that do scroll assert `baseY` explicitly and address rows through it.
import { Terminal } from "@xterm/headless";
import type {
  ITerminalOptions,
  ITerminalInitOnlyOptions,
} from "@xterm/headless";
import { emulationTerminalOptions } from "../terminal/emulationOptions";

/**
 * Construct a headless terminal from the production emulation slice. 80x24 is the vttest-canonical
 * geometry; `allowProposedApi` unlocks the `buffer` inspection API (proposed in xterm 5.x) that the
 * whole harness reads through — it does not alter VT semantics.
 */
export function openTerm(
  overrides?: ITerminalOptions & ITerminalInitOnlyOptions,
): Terminal {
  return new Terminal({
    ...emulationTerminalOptions(),
    allowProposedApi: true,
    cols: 80,
    rows: 24,
    ...overrides,
  });
}

/** Write `data` and resolve once the parser has fully processed it (xterm parses asynchronously). */
export function feed(term: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => term.write(data, resolve));
}

/** Right-trimmed text of a buffer row (leading spaces preserved — they are erase/ICH evidence). */
export function line(term: Terminal, row: number): string {
  const l = term.buffer.active.getLine(row);
  if (!l) {
    throw new Error(
      `line ${row} out of range (buffer length ${term.buffer.active.length})`,
    );
  }
  return l.translateToString(true);
}

/** How a cell's fg/bg color is encoded (SGR default / 256-palette / 24-bit RGB). */
export type ColorMode = "default" | "palette" | "rgb";

/** A plain snapshot of one buffer cell — text, color modes, and the SGR attribute flags. */
export interface CellSnapshot {
  text: string;
  fgMode: ColorMode;
  /**
   * Palette index (0-255) in palette mode; raw 24-bit 0xRRGGBB in rgb mode. In default mode the
   * 5.5.0 runtime returns -1 (the typings' doc-comment says 0 — trust the runtime; the harness
   * pins the shipped behavior).
   */
  fg: number;
  bgMode: ColorMode;
  bg: number;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
}

/**
 * Snapshot the cell at (row, col). The `is*()` accessors return bitmask numbers (see
 * IBufferCell in the headless typings), so flags are coerced to booleans here; RGB colors come
 * back exactly as xterm stores them, a 24-bit 0xRRGGBB number.
 */
export function cellAt(term: Terminal, row: number, col: number): CellSnapshot {
  const cell = term.buffer.active.getLine(row)?.getCell(col);
  if (!cell) {
    throw new Error(`no cell at row ${row}, col ${col}`);
  }
  return {
    text: cell.getChars(),
    fgMode: cell.isFgRGB() ? "rgb" : cell.isFgPalette() ? "palette" : "default",
    fg: cell.getFgColor(),
    bgMode: cell.isBgRGB() ? "rgb" : cell.isBgPalette() ? "palette" : "default",
    bg: cell.getBgColor(),
    bold: !!cell.isBold(),
    dim: !!cell.isDim(),
    italic: !!cell.isItalic(),
    underline: !!cell.isUnderline(),
    inverse: !!cell.isInverse(),
    strike: !!cell.isStrikethrough(),
  };
}

/** Record everything the terminal EMITS toward the pty (reports, mouse SGR, paste data). Live array. */
export function captureData(term: Terminal): string[] {
  const out: string[] = [];
  term.onData((d) => out.push(d));
  return out;
}

/**
 * Record the terminal's binary-unsafe emissions (`onBinary`) — the legacy X10 mouse encoding
 * travels this channel, not `onData`. Live array.
 */
export function captureBinary(term: Terminal): string[] {
  const out: string[] = [];
  term.onBinary((d) => out.push(d));
  return out;
}

/** Record OSC 0/2 title changes (`onTitleChange`). Live array. */
export function captureTitles(term: Terminal): string[] {
  const out: string[] = [];
  term.onTitleChange((t) => out.push(t));
  return out;
}

/** The active buffer's cursor position, 0-based (x may equal `cols` in the wrap-pending state). */
export function cursor(term: Terminal): { x: number; y: number } {
  return { x: term.buffer.active.cursorX, y: term.buffer.active.cursorY };
}

/**
 * Paste as the browser terminal would: LF/CRLF normalized to CR, wrapped in `ESC[200~ / ESC[201~`
 * exactly when the EMULATOR's bracketed-paste mode (DECSET 2004, `modes.bracketedPasteMode`) is on.
 * Verbatim port of xterm.js src/browser/Clipboard.ts (headless ships no `paste()`); emission goes
 * through the public `input()`, which is the same `triggerDataEvent` path the browser uses.
 */
export function paste(term: Terminal, text: string): void {
  const normalized = text.replace(/\r?\n/g, "\r");
  const wrapped = term.modes.bracketedPasteMode
    ? `\x1b[200~${normalized}\x1b[201~`
    : normalized;
  term.input(wrapped, true);
}

/** A core mouse event as `CoreMouseService.triggerMouseEvent` consumes it: 0-based cell coords. */
export interface CoreMouseEventLike {
  col: number;
  row: number;
  /** 0 = left, 1 = middle, 2 = right (CoreMouseButton). */
  button: number;
  /** 0 = up/release, 1 = down/press, 32 = motion (CoreMouseAction). */
  action: number;
}

interface InternalCoreMouseService {
  triggerMouseEvent(e: CoreMouseEventLike): boolean;
}

/**
 * The headless build's mouse-report ingress (see header). Returns `undefined` if a future xterm
 * bump renames the internal — the mouse group asserts it exists so the coverage loss is loud, not
 * silent.
 */
export function mouseService(
  term: Terminal,
): InternalCoreMouseService | undefined {
  const core = (
    term as unknown as {
      _core?: { coreMouseService?: InternalCoreMouseService };
    }
  )._core;
  return core?.coreMouseService;
}
