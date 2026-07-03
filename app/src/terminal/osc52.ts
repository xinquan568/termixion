// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64: OSC 52 app-driven clipboard, WRITE-ONLY. A program running in the terminal may SET the
// clipboard (tmux `set-clipboard`, nvim yank over ssh) — but a query (`Pd === "?"`) is consumed and
// NEVER answered: answering would hand the user's clipboard to any program that can print an escape
// sequence, remote ones included. The payload is `Pc;Pd`, split at the FIRST `;`; Pc (the selection
// — `c`/`p`/`s`, possibly empty) is ignored, Pd is base64. Oversized (> 1 MiB before decoding) or
// undecodable payloads are consumed as inert no-ops — junk from a program must never surface (same
// stance as cursorSettings' payload guard). atob yields latin1 code units, so the bytes go through
// TextDecoder: ASCII is the v0.0.2 contract, but multi-byte UTF-8 must survive unmangled.

/** Pre-decode size guard: a base64 payload longer than this is dropped without decoding. */
const MAX_BASE64_LENGTH = 1024 * 1024; // 1 MiB

/** The slice of an xterm we consume: just the OSC hook of the proposed parser API. */
export interface Osc52TerminalLike {
  readonly parser: {
    registerOscHandler(
      ident: number,
      callback: (data: string) => boolean | Promise<boolean>,
    ): { dispose(): void };
  };
}

/**
 * Register the OSC 52 handler on a terminal. Every OSC 52 sequence is consumed (handled: `true`)
 * so none can fall through to another handler; only a well-formed set request reaches
 * `writeClipboard`. Returns a teardown that unregisters the handler.
 */
export function attachOsc52(
  terminal: Osc52TerminalLike,
  writeClipboard: (text: string) => void,
): () => void {
  const registration = terminal.parser.registerOscHandler(52, (data) => {
    setClipboardFromOsc52(data, writeClipboard);
    return true; // Always consumed — a query in particular must die here, unanswered.
  });
  return () => registration.dispose();
}

/** Apply one OSC 52 payload (`Pc;Pd`). Anything that is not a valid set request is a no-op. */
function setClipboardFromOsc52(data: string, writeClipboard: (text: string) => void): void {
  const separator = data.indexOf(";");
  if (separator === -1) return; // no `Pc;Pd` shape — malformed, drop
  const pd = data.slice(separator + 1);
  if (pd === "?") return; // read request — WRITE-ONLY, never answered
  if (pd.length > MAX_BASE64_LENGTH) return; // pre-decode size guard
  let latin1: string;
  try {
    latin1 = atob(pd);
  } catch {
    return; // not base64 — drop
  }
  // atob maps base64 to latin1 code units (one char per byte); decode those bytes as UTF-8 so a
  // multi-byte yank survives. TextDecoder is non-fatal: garbage becomes U+FFFD, never a throw.
  writeClipboard(new TextDecoder().decode(Uint8Array.from(latin1, (ch) => ch.charCodeAt(0))));
}

/**
 * The production sink: the async Clipboard API, failures swallowed — a clipboard set must never
 * surface as a terminal error (jsdom has no `navigator.clipboard` at all; WKWebView may refuse
 * `writeText` in a packaged app). Verifying the write inside the packaged .app is a manual
 * checklist item; the tauri clipboard-manager plugin is the documented fallback if WKWebView
 * refuses.
 */
export function realWriteClipboard(text: string): void {
  try {
    void navigator.clipboard?.writeText(text).catch(() => {
      // swallowed — see above
    });
  } catch {
    // swallowed — a synchronous refusal (no Clipboard API at all) is equally non-fatal
  }
}
