// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64: the OSC 8 hyperlink activation policy (R8: tests first). Opening is deliberately narrow —
// ⌘-click only (plain click must never open) and http(s) URLs only (javascript:/file:/data:/custom
// schemes and unparseable text are silent no-ops). The sink is injected so the policy tests headless.
import { describe, expect, it, vi } from "vitest";
import type { IBufferRange } from "@xterm/xterm";
import { makeLinkHandler, realOpenUrl } from "./linkHandler";

const range: IBufferRange = { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } };

function click(init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent("click", init);
}

describe("makeLinkHandler", () => {
  it("opens an https URL on ⌘-click, with the exact uri", () => {
    const openUrl = vi.fn();
    makeLinkHandler(openUrl).activate(click({ metaKey: true }), "https://example.com/a?b=1#c", range);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/a?b=1#c");
  });

  it("opens an http URL on ⌘-click", () => {
    const openUrl = vi.fn();
    makeLinkHandler(openUrl).activate(click({ metaKey: true }), "http://example.com/", range);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith("http://example.com/");
  });

  it("does not open on a plain click (no meta), even for https", () => {
    const openUrl = vi.fn();
    makeLinkHandler(openUrl).activate(click(), "https://example.com/", range);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not open javascript: URLs on ⌘-click", () => {
    const openUrl = vi.fn();
    makeLinkHandler(openUrl).activate(click({ metaKey: true }), "javascript:alert(1)", range);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not open file: URLs on ⌘-click", () => {
    const openUrl = vi.fn();
    makeLinkHandler(openUrl).activate(click({ metaKey: true }), "file:///etc/passwd", range);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("ignores unparseable text on ⌘-click without throwing", () => {
    const openUrl = vi.fn();
    const handler = makeLinkHandler(openUrl);
    expect(() => handler.activate(click({ metaKey: true }), "not a url", range)).not.toThrow();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not opt into non-HTTP protocols from the link provider", () => {
    expect(makeLinkHandler(vi.fn()).allowNonHttpProtocols).toBeUndefined();
  });
});

describe("realOpenUrl", () => {
  it("does not throw without a Tauri runtime (jsdom)", () => {
    expect(() => realOpenUrl("https://example.com/")).not.toThrow();
  });
});
