// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-90 (sub-task C): OSC 1337 SetBadgeFormat — the per-pane badge seam. iTerm2's proprietary
// OSC 1337 is a LARGE `<key>=<value>` family (SetUserVar, CurrentDir, RemoteHost, File=…, and many
// more); Termixion implements ONLY `SetBadgeFormat`, the subcommand that sets a pane's translucent
// badge label. Every OTHER 1337 payload — a different key, an unknown key, or one with no `=` at all
// — is a SILENT no-op: consumed (return true) so it never falls through to another handler or prints
// as garbage, but otherwise ignored. Ignoring the rest of the family is the iTerm2-COMPATIBLE stance
// (a terminal that doesn't understand a 1337 subcommand simply drops it), and it keeps this module
// tiny and single-purpose.
//
// The SetBadgeFormat value is base64 (iTerm2 encodes the badge format string), decoded to UTF-8 the
// same way osc52 decodes a clipboard yank: atob → latin1 code units → TextDecoder. An OSC payload is
// untrusted input, so the decoded text is SANITIZED before it can reach the UI (D3, the frozen
// contract — see {@link sanitizeBadge}). An empty value, an undecodable one, or one that sanitizes to
// nothing clears the badge (`setBadge(null)`); junk is never surfaced (same stance as osc52 / osc7 /
// cursorSettings' payload guards).

/** Pre-decode size guard: a base64 value longer than this is dropped without decoding. A badge is a
 * short label, so this is a generous ceiling only a hostile flood would ever hit. */
const MAX_BASE64_LENGTH = 64 * 1024; // 64 KiB

/** Hard cap on a sanitized badge, in UTF-16 code units (D3). */
const MAX_BADGE_LENGTH = 256;

/** The one 1337 subcommand key Termixion implements; every other key is a silent no-op. */
const BADGE_KEY = "SetBadgeFormat";

// CR and CRLF both collapse to a single LF — LF is the only line break a multi-line badge keeps.
// `\r\n?` matches a CRLF or a lone CR (named escapes, not control-literal, so no-control-regex is fine).
const CR_OR_CRLF = /\r\n?/g;

// C0 controls (U+0000–U+001F) EXCEPT LF (U+000A), plus DEL (U+007F): the bytes a hostile OSC payload
// can smuggle into a badge. LF is deliberately preserved (a badge MAY be multi-line, unlike a title,
// so unlike tabTitle we neither drop LF nor strip the C1 range).
// eslint-disable-next-line no-control-regex -- stripping control chars (LF excepted) is the whole point
const CONTROL_CHARS_EXCEPT_LF = /[\u{0}-\u{9}\u{b}-\u{1f}\u{7f}]/gu;

/**
 * The slice of an xterm we consume: just the OSC hook of the proposed parser API (the same shape as
 * `Osc52TerminalLike`). `parser` is xterm's proposed API — a real terminal must be constructed with
 * `allowProposedApi: true`; the narrow shape fits both `@xterm/xterm` and `@xterm/headless`.
 */
export interface Osc1337TerminalLike {
  readonly parser: {
    registerOscHandler(
      ident: number,
      callback: (data: string) => boolean | Promise<boolean>,
    ): { dispose(): void };
  };
}

/**
 * Register the OSC 1337 handler on `terminal`. EVERY OSC 1337 sequence is consumed (handled: `true`)
 * so none can fall through to another handler or print as garbage; only a well-formed
 * `SetBadgeFormat=<base64>` reaches `setBadge`. `setBadge(null)` CLEARS the badge (an empty,
 * undecodable, or sanitizes-to-empty value); a sanitized non-empty string SETS it. Returns a
 * teardown that unregisters the handler.
 */
export function attachOsc1337(
  terminal: Osc1337TerminalLike,
  setBadge: (badge: string | null) => void,
): () => void {
  const registration = terminal.parser.registerOscHandler(1337, (data) => {
    applyOsc1337(data, setBadge);
    return true; // Always consumed — an unhandled 1337 subcommand must die here, silently.
  });
  return () => registration.dispose();
}

/**
 * Apply one OSC 1337 payload (`<key>=<value>`). Only `SetBadgeFormat` acts; everything else is a
 * SILENT no-op — a payload with no `=`, a different key, an unknown key, or an oversized/undecodable
 * base64 value. Split at the FIRST `=` so a value that itself contains `=` (e.g. `SetUserVar=x=y`)
 * still parses as the correct key and is correctly ignored.
 */
function applyOsc1337(data: string, setBadge: (badge: string | null) => void): void {
  const separator = data.indexOf("=");
  if (separator === -1) return; // no `<key>=<value>` shape — not a subcommand we act on
  if (data.slice(0, separator) !== BADGE_KEY) return; // a different 1337 subcommand — silently ignored
  const value = data.slice(separator + 1);
  if (value.length > MAX_BASE64_LENGTH) return; // pre-decode size guard
  let latin1: string;
  try {
    latin1 = atob(value);
  } catch {
    return; // not base64 — inert no-op, never surfaced
  }
  // atob maps base64 → latin1 code units (one char per byte); decode those bytes as UTF-8 so a
  // multi-byte badge survives. TextDecoder is non-fatal: garbage becomes U+FFFD, never a throw.
  const decoded = new TextDecoder().decode(Uint8Array.from(latin1, (ch) => ch.charCodeAt(0)));
  const badge = sanitizeBadge(decoded);
  setBadge(badge === "" ? null : badge); // empty (originally, or after sanitizing) clears the badge
}

/**
 * The D3 sanitization contract, applied IN ORDER: (1) collapse CR and CRLF → LF; (2) strip every C0
 * control char EXCEPT LF, plus DEL (U+007F); (3) cap at {@link MAX_BADGE_LENGTH} chars (truncate).
 * LF is the ONLY line break preserved — a badge may be multi-line. May return "" (the caller then
 * clears the badge).
 */
function sanitizeBadge(raw: string): string {
  const oneLineBreak = raw.replace(CR_OR_CRLF, "\n"); // CR / CRLF → LF (LF now the only break)
  const stripped = oneLineBreak.replace(CONTROL_CHARS_EXCEPT_LF, ""); // other C0 + DEL gone; LF kept
  return stripped.slice(0, MAX_BADGE_LENGTH); // truncate at the 256 code-unit cap
}
