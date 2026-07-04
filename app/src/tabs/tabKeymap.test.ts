// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-74 (test-first): the pure tab keymap. ⌘1..⌘9 select a tab (index 8 = last, the iTerm2 ⌘9
// rule applied by the reducer); everything else — extra modifiers, non-digits, ⌘C/⌘V/⌘T/⌘W — is
// never intercepted. Editable-target inertness is scoped to NON-terminal inputs: xterm's hidden
// helper textarea is technically editable, but it lives inside `.terminal-host`, so the keymap
// still FIRES there (a focused terminal is exactly where tab switching must work); a settings
// <input> outside the terminal keeps its digits. `describeTarget` pins that DOM distinction.
import { describe, it, expect } from "vitest";
import { describeTarget, tabKeyAction, type KeyTarget, type TabKeyEvent } from "./tabKeymap";

/** A key event with all modifiers off unless overridden. */
function ev(key: string, mods: Partial<Omit<TabKeyEvent, "key">> = {}): TabKeyEvent {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods };
}

const cmd = (key: string, mods: Partial<Omit<TabKeyEvent, "key">> = {}) =>
  ev(key, { metaKey: true, ...mods });

/** The terminal's hidden textarea: editable, but INSIDE the terminal — the keymap fires. */
const TERMINAL: KeyTarget = { isTerminalTarget: true, isEditableTarget: true };
/** A non-editable page target (e.g. body) — the keymap fires. */
const PAGE: KeyTarget = { isTerminalTarget: false, isEditableTarget: false };
/** A non-terminal editable (e.g. a settings <input>) — the keymap must stay inert. */
const EDITABLE: KeyTarget = { isTerminalTarget: false, isEditableTarget: true };

describe("tabKeyAction", () => {
  it.each([
    ["1", 0],
    ["2", 1],
    ["3", 2],
    ["4", 3],
    ["5", 4],
    ["6", 5],
    ["7", 6],
    ["8", 7],
    ["9", 8], // index 8 — the reducer maps it to the LAST tab (iTerm2 ⌘9)
  ])("⌘%s → select-index %i", (key, index) => {
    expect(tabKeyAction(cmd(key), PAGE)).toEqual({ kind: "select-index", index });
  });

  it("fires on the terminal target even though xterm's textarea is editable", () => {
    expect(tabKeyAction(cmd("1"), TERMINAL)).toEqual({ kind: "select-index", index: 0 });
    expect(tabKeyAction(cmd("9"), TERMINAL)).toEqual({ kind: "select-index", index: 8 });
  });

  it("is inert on a NON-terminal editable target (settings inputs keep their digits)", () => {
    expect(tabKeyAction(cmd("1"), EDITABLE)).toBeNull();
    expect(tabKeyAction(cmd("9"), EDITABLE)).toBeNull();
  });

  it.each([
    ["shift", { shiftKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["alt", { altKey: true }],
  ])("any extra modifier (⌘+%s) → null", (_name, extra) => {
    expect(tabKeyAction(cmd("1", extra), PAGE)).toBeNull();
    expect(tabKeyAction(cmd("9", extra), TERMINAL)).toBeNull();
  });

  it("requires meta: bare digits and ctrl-digits are never intercepted", () => {
    expect(tabKeyAction(ev("1"), PAGE)).toBeNull();
    expect(tabKeyAction(ev("1", { ctrlKey: true }), PAGE)).toBeNull();
  });

  it.each(["c", "v", "t", "w", "C", "V", "0", "a", "Enter", "Tab", "[", "10"])(
    "never intercepts ⌘%s (non-digit / reserved shortcuts pass through)",
    (key) => {
      expect(tabKeyAction(cmd(key), PAGE)).toBeNull();
      expect(tabKeyAction(cmd(key), TERMINAL)).toBeNull();
    },
  );
});

describe("tabKeyAction — split (trmx-84 FR-3.2)", () => {
  it.each(["d", "D"])("⌘%s → split right", (key) => {
    expect(tabKeyAction(cmd(key), PAGE)).toEqual({ kind: "split", dir: "right" });
    expect(tabKeyAction(cmd(key), TERMINAL)).toEqual({ kind: "split", dir: "right" });
  });

  it.each(["d", "D"])("⇧⌘%s → split below", (key) => {
    expect(tabKeyAction(cmd(key, { shiftKey: true }), PAGE)).toEqual({
      kind: "split",
      dir: "below",
    });
    expect(tabKeyAction(cmd(key, { shiftKey: true }), TERMINAL)).toEqual({
      kind: "split",
      dir: "below",
    });
  });

  it("split fires on the terminal target but is inert on a NON-terminal editable", () => {
    expect(tabKeyAction(cmd("d"), TERMINAL)).toEqual({ kind: "split", dir: "right" });
    expect(tabKeyAction(cmd("d"), EDITABLE)).toBeNull();
    expect(tabKeyAction(cmd("d", { shiftKey: true }), EDITABLE)).toBeNull();
  });

  it("requires exactly meta(+shift): ⌘⌃D / ⌘⌥D and bare D pass through", () => {
    expect(tabKeyAction(cmd("d", { ctrlKey: true }), PAGE)).toBeNull();
    expect(tabKeyAction(cmd("d", { altKey: true }), PAGE)).toBeNull();
    expect(tabKeyAction(ev("d"), PAGE)).toBeNull();
  });
});

describe("describeTarget", () => {
  it("detects xterm's helper textarea inside .terminal-host as a terminal target", () => {
    // Build the real DOM shape: TerminalView renders <div class="terminal-host"> and xterm
    // mounts its hidden <textarea class="xterm-helper-textarea"> inside it.
    const host = document.createElement("div");
    host.className = "terminal-host";
    const screen = document.createElement("div");
    screen.className = "xterm";
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    screen.appendChild(textarea);
    host.appendChild(screen);
    document.body.appendChild(host);
    try {
      expect(describeTarget(textarea)).toEqual({
        isTerminalTarget: true,
        isEditableTarget: true,
      });
      // End-to-end with the keymap: ⌘1 on the focused terminal DISPATCHES.
      expect(tabKeyAction(cmd("1"), describeTarget(textarea))).toEqual({
        kind: "select-index",
        index: 0,
      });
    } finally {
      host.remove();
    }
  });

  it("classifies a bare <input> outside the terminal as editable, non-terminal (keymap inert)", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      expect(describeTarget(input)).toEqual({
        isTerminalTarget: false,
        isEditableTarget: true,
      });
      expect(tabKeyAction(cmd("1"), describeTarget(input))).toBeNull();
    } finally {
      input.remove();
    }
  });

  it.each(["textarea", "select"])(
    "classifies a bare <%s> outside the terminal as editable",
    (tag) => {
      const el = document.createElement(tag);
      expect(describeTarget(el)).toEqual({
        isTerminalTarget: false,
        isEditableTarget: true,
      });
    },
  );

  it("classifies a contenteditable element outside the terminal as editable", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "");
    expect(describeTarget(div).isEditableTarget).toBe(true);
    div.setAttribute("contenteditable", "true");
    expect(describeTarget(div).isEditableTarget).toBe(true);
  });

  it('does not treat contenteditable="false" as editable', () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "false");
    expect(describeTarget(div).isEditableTarget).toBe(false);
  });

  it("classifies a plain element as neither terminal nor editable", () => {
    expect(describeTarget(document.createElement("div"))).toEqual({
      isTerminalTarget: false,
      isEditableTarget: false,
    });
    expect(describeTarget(document.body)).toEqual({
      isTerminalTarget: false,
      isEditableTarget: false,
    });
  });

  it("classifies a non-editable element INSIDE the terminal as a terminal target", () => {
    const host = document.createElement("div");
    host.className = "terminal-host";
    const row = document.createElement("div");
    host.appendChild(row);
    document.body.appendChild(host);
    try {
      expect(describeTarget(row)).toEqual({
        isTerminalTarget: true,
        isEditableTarget: false,
      });
    } finally {
      host.remove();
    }
  });

  it.each([null, undefined, "textarea", 42, {}])(
    "defensively maps a non-Element input (%j) to { false, false }",
    (junk) => {
      expect(describeTarget(junk)).toEqual({
        isTerminalTarget: false,
        isEditableTarget: false,
      });
    },
  );

  it("defensively maps non-Element DOM objects (document, window) to { false, false }", () => {
    expect(describeTarget(document)).toEqual({
      isTerminalTarget: false,
      isEditableTarget: false,
    });
    expect(describeTarget(window)).toEqual({
      isTerminalTarget: false,
      isEditableTarget: false,
    });
  });
});
