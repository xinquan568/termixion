// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-90 (sub-task C, test-first): OSC 1337 SetBadgeFormat over a FAKE terminal slice. The fake
// captures the OSC handler `attachOsc1337` registers, so each case can invoke it directly and assert
// BOTH the setBadge effect AND that the handler ALWAYS returns true — every 1337 sequence is consumed,
// so nothing (not even an ignored subcommand or junk) falls through or prints as garbage. The D3
// sanitization contract is exercised here: LF preserved, CR/CRLF collapsed, other C0 + DEL stripped,
// a 256-char cap, and empty/undecodable/sanitizes-to-empty → clear (`setBadge(null)`).
import { describe, expect, it, vi } from "vitest";
import { attachOsc1337, type Osc1337TerminalLike } from "./osc1337";

/** base64 of a string's UTF-8 bytes — the encoding iTerm2 uses for a SetBadgeFormat value. Works for
 * multi-byte text too (the latin1 dance mirrors the atob path the handler decodes with). */
function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** A fake xterm slice: records the OSC ident + handler `attachOsc1337` registers, exposes an
 * `invoke` that calls the handler the way the parser would, plus a dispose spy for teardown. */
function fakeOsc1337Terminal() {
  let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
  let ident: number | undefined;
  const dispose = vi.fn();
  const terminal: Osc1337TerminalLike = {
    parser: {
      registerOscHandler(id, callback) {
        ident = id;
        handler = callback;
        return { dispose };
      },
    },
  };
  return {
    terminal,
    dispose,
    get ident() {
      return ident;
    },
    invoke(data: string): boolean | Promise<boolean> {
      if (!handler) throw new Error("no OSC 1337 handler registered");
      return handler(data);
    },
  };
}

describe("attachOsc1337", () => {
  it("registers on OSC 1337", () => {
    const fake = fakeOsc1337Terminal();
    attachOsc1337(fake.terminal, vi.fn());
    expect(fake.ident).toBe(1337);
  });

  it("sets the sanitized badge for SetBadgeFormat=<base64>", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke(`SetBadgeFormat=${b64("DB PROD")}`)).toBe(true);
    expect(setBadge).toHaveBeenCalledTimes(1);
    expect(setBadge).toHaveBeenCalledWith("DB PROD");
  });

  it("decodes a multi-byte UTF-8 badge through the byte path (atob is latin1)", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke(`SetBadgeFormat=${b64("héllo — 你好")}`)).toBe(true);
    expect(setBadge).toHaveBeenCalledWith("héllo — 你好");
  });

  it("clears the badge for an empty value (SetBadgeFormat=)", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke("SetBadgeFormat=")).toBe(true);
    expect(setBadge).toHaveBeenCalledTimes(1);
    expect(setBadge).toHaveBeenCalledWith(null);
  });

  it('clears the badge for an empty DECODED value (base64 of "")', () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke(`SetBadgeFormat=${b64("")}`)).toBe(true);
    expect(setBadge).toHaveBeenCalledWith(null);
  });

  it("drops an undecodable base64 value without calling setBadge (still consumed)", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke("SetBadgeFormat=%%not-base64%%")).toBe(true);
    expect(setBadge).not.toHaveBeenCalled();
  });

  it("drops a value over the pre-decode size guard (still consumed)", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    // Valid base64 chars — would decode fine, rejected purely by the pre-decode length guard.
    const oversized = "A".repeat(64 * 1024 + 4);
    expect(fake.invoke(`SetBadgeFormat=${oversized}`)).toBe(true);
    expect(setBadge).not.toHaveBeenCalled();
  });

  it("truncates a decoded badge longer than 256 chars", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke(`SetBadgeFormat=${b64("a".repeat(300))}`)).toBe(true);
    expect(setBadge).toHaveBeenCalledWith("a".repeat(256));
  });

  it("preserves LF: a multi-line badge keeps its line break", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke(`SetBadgeFormat=${b64("a\nb")}`)).toBe(true);
    expect(setBadge).toHaveBeenCalledWith("a\nb");
  });

  it("normalizes CRLF to a single LF", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke(`SetBadgeFormat=${b64("a\r\nb")}`)).toBe(true);
    expect(setBadge).toHaveBeenCalledWith("a\nb");
  });

  it("normalizes a lone CR to LF", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke(`SetBadgeFormat=${b64("a\rb")}`)).toBe(true);
    expect(setBadge).toHaveBeenCalledWith("a\nb");
  });

  it("strips other C0 controls (TAB, BEL) while keeping the surrounding text", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke(`SetBadgeFormat=${b64("a\tb\x07c")}`)).toBe(true);
    expect(setBadge).toHaveBeenCalledWith("abc");
  });

  it("clears the badge when the value is nothing BUT control chars (sanitizes to empty)", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke(`SetBadgeFormat=${b64("\t\x07\x7f")}`)).toBe(true);
    expect(setBadge).toHaveBeenCalledWith(null);
  });

  it("ignores SetUserVar (a different 1337 subcommand) — no setBadge, still consumed", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    // Value contains '=' — the handler splits at the FIRST '=', so the key is "SetUserVar".
    expect(fake.invoke("SetUserVar=x=y")).toBe(true);
    expect(setBadge).not.toHaveBeenCalled();
  });

  it("ignores CurrentDir (a different 1337 subcommand) — no setBadge, still consumed", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke("CurrentDir=/tmp")).toBe(true);
    expect(setBadge).not.toHaveBeenCalled();
  });

  it("ignores a payload with no '=' at all — still consumed", () => {
    const fake = fakeOsc1337Terminal();
    const setBadge = vi.fn();
    attachOsc1337(fake.terminal, setBadge);
    expect(fake.invoke("SetBadgeFormat")).toBe(true);
    expect(setBadge).not.toHaveBeenCalled();
  });

  it("teardown disposes the registration", () => {
    const fake = fakeOsc1337Terminal();
    const teardown = attachOsc1337(fake.terminal, vi.fn());
    teardown();
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });
});
