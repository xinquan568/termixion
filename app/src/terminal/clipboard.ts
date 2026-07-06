// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-66: the owned ⌘C/⌘V clipboard chain. Termixion takes deterministic ownership of the DOM
// copy/paste events instead of riding xterm's built-in handlers, for three load-bearing reasons:
// (1) SAFETY — xterm 5.5's paste transform is exactly LF-normalize + bracketed-paste wrap with NO
// payload sanitization, so a malicious clipboard containing a literal ESC[201~ would terminate the
// bracket early and smuggle "typed" input; sanitizePaste() strips it before the wrap. (2) xterm's
// paste handler reads the event WITHOUT checking defaultPrevented (registered on the .xterm element
// AND its textarea), so the guards below run in the CAPTURE phase on the host and stopPropagation()
// — preventDefault alone would still be followed by xterm's unsanitized paste. (3) copy with no
// selection must attempt NO clipboard write at all (not clear it) while ⌃C — a keydown, never a DOM
// copy event — stays untouched by construction. Pure logic over narrow slices (house pattern);
// TerminalView binds it via an injectable seam.
import type { ITerminalOptions } from "@xterm/xterm";

/** The clipboard-event slice the handlers read — fake-testable (jsdom ClipboardEvent is partial). */
export interface ClipboardEventLike {
  clipboardData: {
    getData(type: string): string;
    setData(type: string, value: string): void;
  } | null;
  preventDefault(): void;
  stopPropagation(): void;
}

/** The terminal slice copy needs. */
export interface CopyTerminalLike {
  hasSelection(): boolean;
  /** xterm joins selected rows with \n and unwraps soft-wrapped logical lines. */
  getSelection(): string;
}

/** The terminal slice paste needs — `paste()` applies LF→CR + bracketed-paste wrapping. */
export interface PasteTerminalLike {
  paste(text: string): void;
}

/** Strip every embedded bracketed-paste terminator so a paste can never escape its own bracket. */
export function sanitizePaste(text: string): string {
  return text.split("\x1b[201~").join("");
}

/**
 * trmx-95: the ONE "selection → clipboard string" extraction, shared by ⌘C ([`handleCopyEvent`]) and
 * auto-copy-on-select (`copyOnSelect.ts`). It is just `terminal.getSelection()` (xterm joins selected
 * rows with `\n` and unwraps soft-wrapped logical lines) — a single source of truth so an auto-copy
 * is BYTE-IDENTICAL to a ⌘C for the same selection (a divergence would be a trust bug).
 */
export function selectionText(terminal: CopyTerminalLike): string {
  return terminal.getSelection();
}

/**
 * ⌘C / Edit→Copy. With a selection: write it as text/plain and own the event. Without: attempt NO
 * write (suppressing default + propagation keeps xterm's element handler from writing either), so
 * the platform preserves whatever is on the clipboard.
 */
export function handleCopyEvent(ev: ClipboardEventLike, terminal: CopyTerminalLike): void {
  if (terminal.hasSelection()) {
    ev.clipboardData?.setData("text/plain", selectionText(terminal));
  }
  ev.preventDefault();
  ev.stopPropagation();
}

/**
 * ⌘V / Edit→Paste. text/plain only; sanitized; delivered through terminal.paste() so xterm's own
 * normalization + DECSET-2004 wrapping (conformance-pinned in trmx-64) still applies.
 */
export function handlePasteEvent(ev: ClipboardEventLike, terminal: PasteTerminalLike): void {
  const text = ev.clipboardData?.getData("text/plain") ?? "";
  ev.preventDefault();
  ev.stopPropagation();
  if (text.length > 0) terminal.paste(sanitizePaste(text));
}

/**
 * Bind both guards on the terminal HOST in the capture phase — structurally ahead of xterm's own
 * handlers on the `.xterm` element (copy + paste) and its textarea (paste) for events originating
 * at either node. Returns a teardown that removes both listeners.
 */
export function attachClipboardGuards(
  host: Pick<HTMLElement, "addEventListener" | "removeEventListener">,
  terminal: CopyTerminalLike & PasteTerminalLike,
): () => void {
  const onCopy = (ev: Event) => handleCopyEvent(ev as unknown as ClipboardEventLike, terminal);
  const onPaste = (ev: Event) => handlePasteEvent(ev as unknown as ClipboardEventLike, terminal);
  host.addEventListener("copy", onCopy, { capture: true });
  host.addEventListener("paste", onPaste, { capture: true });
  return () => {
    host.removeEventListener("copy", onCopy, { capture: true });
    host.removeEventListener("paste", onPaste, { capture: true });
  };
}

/**
 * Selection-UX option slice for the chokepoint: while a full-screen app owns the mouse (trmx-64
 * mouse reporting), Option-drag still makes a normal selection — the iTerm2 convention on macOS.
 * Keyboard Option-as-Meta is a separate concern and is unaffected.
 */
export function clipboardTerminalOptions(): ITerminalOptions {
  return {
    macOptionClickForcesSelection: true,
  };
}
