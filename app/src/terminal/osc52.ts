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
//
// trmx-252 (L11) adds the WRITE POLICY. Even write-only, OSC 52 lets anything that can print to the
// terminal — a remote shell, a piped script — silently replace what the user is about to paste, so
// `terminal.clipboardWrite = "deny"` turns the write off. `deny` still CONSUMES the sequence
// (`return true`), matching the stance already taken for queries and oversized payloads: nothing an
// OSC 52 carries may fall through. The policy is read AT WRITE TIME through an injected thunk, never
// captured at attach time — see {@link Osc52Options.policy}.

/** Pre-decode size guard: a base64 payload longer than this is dropped without decoding. */
const MAX_BASE64_LENGTH = 1024 * 1024; // 1 MiB

/**
 * trmx-252 (L11): the clipboard-write policy for OSC 52 — the `terminal.clipboardWrite` setting
 * (`allow` | `deny`), stored in `termixion-core`'s config as data and ENFORCED here, at the write.
 */
export type ClipboardWritePolicy = "allow" | "deny";

/** Optional wiring for {@link attachOsc52}. */
export interface Osc52Options {
  /**
   * The live policy, READ AT WRITE TIME — never captured at attach time. The handler is registered
   * ONCE per pane (TerminalView's mount effect), so a value captured at attach would freeze the
   * setting until a remount: flipping it in Settings would silently appear to need a restart.
   * Omitted → `allow`, the pre-trmx-252 behaviour.
   */
  policy?: () => ClipboardWritePolicy;
  /**
   * Called when a well-formed set request is ACCEPTED (policy `allow`, payload decoded, the write
   * dispatched) — drives the per-pane notice. It reports an accepted REQUEST, not a completed
   * clipboard change: the native write crosses IPC and swallows async failure (nativeClipboard.ts),
   * so nothing here can observe whether the pasteboard actually changed.
   */
  onAccepted?: () => void;
}

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
  options: Osc52Options = {},
): () => void {
  const registration = terminal.parser.registerOscHandler(52, (data) => {
    setClipboardFromOsc52(data, writeClipboard, options);
    return true; // Always consumed — a query in particular must die here, unanswered.
  });
  return () => registration.dispose();
}

/** Apply one OSC 52 payload (`Pc;Pd`). Anything that is not a valid set request is a no-op. */
function setClipboardFromOsc52(
  data: string,
  writeClipboard: (text: string) => void,
  options: Osc52Options,
): void {
  const separator = data.indexOf(";");
  if (separator === -1) return; // no `Pc;Pd` shape — malformed, drop
  const pd = data.slice(separator + 1);
  if (pd === "?") return; // read request — WRITE-ONLY, never answered
  if (pd.length > MAX_BASE64_LENGTH) return; // pre-decode size guard
  // trmx-252: the write policy, read HERE (at write time) rather than at attach time. `deny`
  // returns without writing; the caller still returns `true`, so the sequence is CONSUMED —
  // the same stance as a query or an oversized payload, and the reason the check lives after the
  // shape guards but before the decode (a denied payload is never even base64-decoded).
  if ((options.policy?.() ?? "allow") === "deny") return;
  let latin1: string;
  try {
    latin1 = atob(pd);
  } catch {
    return; // not base64 — drop
  }
  // atob maps base64 to latin1 code units (one char per byte); decode those bytes as UTF-8 so a
  // multi-byte yank survives. TextDecoder is non-fatal: garbage becomes U+FFFD, never a throw.
  writeClipboard(new TextDecoder().decode(Uint8Array.from(latin1, (ch) => ch.charCodeAt(0))));
  options.onAccepted?.();
}

/**
 * The production sink — since trmx-145 the NATIVE clipboard write (the clipboard-manager plugin
 * over Tauri IPC), re-exported so OSC 52, auto-copy-on-select, and the ⌘C guard share ONE function
 * object. The webview's `navigator.clipboard.writeText` is retired here: its writes reached other
 * apps UTF-8-re-decoded-as-MacRoman (the trmx-145 mojibake), and it could refuse gesture-less
 * writes in a packaged app — the IPC path has neither problem. Failure tolerance (swallowed sync +
 * async errors) lives on the sink itself; verifying the write inside the packaged .app remains a
 * manual checklist item.
 */
export { writeClipboardText as realWriteClipboard } from "./nativeClipboard";
