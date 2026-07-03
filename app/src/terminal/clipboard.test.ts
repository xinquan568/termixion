// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-66 (test-first): the owned ⌘C/⌘V clipboard chain. The handlers are pure logic over narrow
// event/terminal slices (fake-testable — jsdom's ClipboardEvent support is partial by design here);
// the binding tests prove the LOAD-BEARING property: xterm's own copy/paste handlers (registered on
// the .xterm element and, for paste, also on its textarea) read the event WITHOUT checking
// defaultPrevented — so the host-capture guards must stopPropagation() or a sanitized paste would
// be followed by xterm's unsanitized one. Two separate origin cases pin exactly that.
import { describe, it, expect, vi } from "vitest";
import {
  sanitizePaste,
  handleCopyEvent,
  handlePasteEvent,
  attachClipboardGuards,
  clipboardTerminalOptions,
} from "./clipboard";

function fakeEvent(text = "") {
  return {
    clipboardData: {
      getData: vi.fn((type: string) => (type === "text/plain" ? text : "")),
      setData: vi.fn(),
    },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe("sanitizePaste (the ESC[201~ bracket-escape rail)", () => {
  it("strips the bracket terminator wherever it appears", () => {
    expect(sanitizePaste("evil\x1b[201~payload")).toBe("evilpayload");
    expect(sanitizePaste("\x1b[201~lead")).toBe("lead");
    expect(sanitizePaste("tail\x1b[201~")).toBe("tail");
    expect(sanitizePaste("a\x1b[201~b\x1b[201~c")).toBe("abc");
    expect(sanitizePaste("\x1b[201~\x1b[201~")).toBe("");
  });

  it("leaves normal text, newlines, and tabs intact", () => {
    expect(sanitizePaste("plain text")).toBe("plain text");
    expect(sanitizePaste("line1\nline2\r\nline3\tend")).toBe("line1\nline2\r\nline3\tend");
    expect(sanitizePaste("")).toBe("");
  });
});

describe("handleCopyEvent", () => {
  it("with a selection: writes text/plain from getSelection and owns the event", () => {
    const ev = fakeEvent();
    const term = { hasSelection: () => true, getSelection: () => "line1\nline2" };
    handleCopyEvent(ev, term);
    expect(ev.clipboardData.setData).toHaveBeenCalledWith("text/plain", "line1\nline2");
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(ev.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("without a selection: attempts NO write and suppresses default + propagation", () => {
    // Contract: no setData at all — neither we nor xterm's element handler write anything, so the
    // platform preserves the existing clipboard (end-to-end confirmation is the packaged checklist;
    // a fake event can only prove "no write attempted").
    const ev = fakeEvent();
    const term = { hasSelection: () => false, getSelection: () => "" };
    handleCopyEvent(ev, term);
    expect(ev.clipboardData.setData).not.toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(ev.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

describe("handlePasteEvent", () => {
  it("routes text/plain through sanitizePaste into terminal.paste and owns the event", () => {
    const ev = fakeEvent("safe\x1b[201~; rm -rf /\nnext");
    const paste = vi.fn();
    handlePasteEvent(ev, { paste });
    expect(ev.clipboardData.getData).toHaveBeenCalledWith("text/plain");
    expect(paste).toHaveBeenCalledWith("safe; rm -rf /\nnext");
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(ev.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("consumes an empty clipboard without pasting", () => {
    const ev = fakeEvent("");
    const paste = vi.fn();
    handlePasteEvent(ev, { paste });
    expect(paste).not.toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(ev.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

describe("attachClipboardGuards (host-capture binding — the propagation pins)", () => {
  // Build the xterm-like DOM: host > .xterm element > textarea — xterm registers copy+paste on the
  // element and paste (again) on the textarea; the guards live above both, on the host, in capture.
  function makeDom() {
    const host = document.createElement("div");
    const xtermEl = document.createElement("div");
    xtermEl.className = "xterm";
    const textarea = document.createElement("textarea");
    xtermEl.appendChild(textarea);
    host.appendChild(xtermEl);
    document.body.appendChild(host);
    return { host, xtermEl, textarea };
  }

  function dispatchFrom(origin: HTMLElement, type: "copy" | "paste") {
    // jsdom's ClipboardEvent constructor doesn't carry clipboardData — plant it on a plain Event,
    // exactly the slice our handlers read.
    const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: (t: string) => string; setData: (t: string, v: string) => void };
    };
    ev.clipboardData = { getData: () => "pasted", setData: () => {} };
    origin.dispatchEvent(ev);
    return ev;
  }

  const term = {
    hasSelection: () => true,
    getSelection: () => "sel",
    paste: vi.fn(),
  };

  for (const originName of ["xterm-element", "textarea"] as const) {
    it(`origin ${originName}: the guard intercepts copy+paste and xterm's would-be handler never fires`, () => {
      const { host, xtermEl, textarea } = makeDom();
      const origin = originName === "xterm-element" ? xtermEl : textarea;
      // Plant listeners exactly where xterm registers its own (bubble phase, same node).
      const xtermCopySpy = vi.fn();
      const xtermPasteSpy = vi.fn();
      xtermEl.addEventListener("copy", xtermCopySpy);
      xtermEl.addEventListener("paste", xtermPasteSpy);
      textarea.addEventListener("paste", xtermPasteSpy);

      const dispose = attachClipboardGuards(host, term);
      term.paste.mockClear();

      dispatchFrom(origin, "copy");
      dispatchFrom(origin, "paste");
      expect(term.paste).toHaveBeenCalledWith("pasted"); // guard handled paste
      expect(xtermCopySpy).not.toHaveBeenCalled(); // propagation stopped
      expect(xtermPasteSpy).not.toHaveBeenCalled();

      // Teardown: the same dispatches now reach the planted listeners.
      dispose();
      dispatchFrom(origin, "copy");
      dispatchFrom(origin, "paste");
      expect(xtermCopySpy).toHaveBeenCalled();
      expect(xtermPasteSpy).toHaveBeenCalled();
      host.remove();
    });
  }
});

describe("multi-line fidelity through the REAL xterm selection (integration)", () => {
  it("copies a two-line selection with the line break intact", async () => {
    // The \n-join contract of getSelection() over the real browser build (jsdom environment; the
    // DOM renderer degrades without canvas but buffer + selection APIs function).
    // xterm's CoreBrowserService dereferences window.matchMedia at open(); jsdom lacks it — stub
    // the minimal slice (same approach as realDeps.test.ts).
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    const { Terminal } = await import("@xterm/xterm");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 5 });
    try {
      term.open(host);
      await new Promise<void>((r) => term.write("line1\r\nline2", () => r()));
      term.selectAll();
      const ev = fakeEvent();
      handleCopyEvent(ev, term);
      const payload = (ev.clipboardData.setData as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as string;
      expect(payload).toContain("line1");
      expect(payload).toContain("line2");
      expect(payload).toMatch(/line1\n/); // the break survives as \n
    } finally {
      term.dispose();
      host.remove();
    }
  });
});

describe("clipboardTerminalOptions", () => {
  it("enables Option-drag selection over mouse-capturing apps (iTerm2 convention)", () => {
    expect(clipboardTerminalOptions()).toEqual({ macOptionClickForcesSelection: true });
  });
});
