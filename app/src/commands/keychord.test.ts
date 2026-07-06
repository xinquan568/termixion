// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import { describe, expect, it } from "vitest";
import {
  canonicalChord,
  canonicalChordFromEvent,
  chordFromEvent,
  parseChord,
  validateBinding,
  type Chord,
} from "./keychord";

const chord = (over: Partial<Chord>): Chord => ({
  cmd: false,
  ctrl: false,
  alt: false,
  shift: false,
  key: "",
  ...over,
});

describe("parseChord", () => {
  it("parses modifiers + key, order-insensitively, with cmd/meta alias", () => {
    expect(parseChord("cmd+shift+p")).toEqual(chord({ cmd: true, shift: true, key: "p" }));
    expect(parseChord("shift+cmd+p")).toEqual(chord({ cmd: true, shift: true, key: "p" }));
    expect(parseChord("meta+p")).toEqual(chord({ cmd: true, key: "p" }));
    expect(parseChord("CMD+P")).toEqual(chord({ cmd: true, key: "p" }));
  });

  it("normalizes arrow/named keys and option/opt alias", () => {
    expect(parseChord("cmd+alt+left")).toEqual(chord({ cmd: true, alt: true, key: "left" }));
    expect(parseChord("cmd+option+arrowdown")).toEqual(chord({ cmd: true, alt: true, key: "down" }));
    expect(parseChord("ctrl+`")).toEqual(chord({ ctrl: true, key: "`" }));
    expect(parseChord("cmd+enter")).toEqual(chord({ cmd: true, key: "enter" }));
  });

  it("rejects empty, key-less, two-key, and unknown-token chords", () => {
    expect(parseChord("")).toHaveProperty("error");
    expect(parseChord("cmd+shift")).toHaveProperty("error"); // no key
    expect(parseChord("cmd+a+b")).toHaveProperty("error"); // two keys
    expect(parseChord("cmd+nope")).toHaveProperty("error"); // unknown key name
  });
});

describe("canonicalChord", () => {
  it("emits modifiers in fixed order regardless of input spelling", () => {
    const a = parseChord("shift+cmd+d") as Chord;
    const b = parseChord("cmd+shift+d") as Chord;
    expect(canonicalChord(a)).toBe("cmd+shift+d");
    expect(canonicalChord(a)).toBe(canonicalChord(b));
  });
});

describe("chordFromEvent / canonicalChordFromEvent", () => {
  it("derives a chord from a keydown event, normalizing arrows/space/case", () => {
    expect(chordFromEvent({ key: "D", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toEqual(
      chord({ cmd: true, shift: true, key: "d" }),
    );
    expect(canonicalChordFromEvent({ key: "ArrowLeft", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBe(
      "cmd+alt+left",
    );
    expect(canonicalChordFromEvent({ key: " ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(
      "cmd+space",
    );
  });

  it("round-trips a parsed chord through an event of the same shape", () => {
    const parsed = parseChord("cmd+shift+p") as Chord;
    expect(canonicalChordFromEvent({ key: "p", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true })).toBe(
      canonicalChord(parsed),
    );
  });
});

describe("validateBinding", () => {
  it("accepts cmd chords and ctrl+shift chords", () => {
    expect(validateBinding(chord({ cmd: true, key: "p" }))).toEqual({ ok: true });
    expect(validateBinding(chord({ ctrl: true, shift: true, key: "p" }))).toEqual({ ok: true });
  });

  it("refuses non-cmd (terminal-owned) chords", () => {
    expect(validateBinding(chord({ key: "a" })).ok).toBe(false);
    expect(validateBinding(chord({ ctrl: true, key: "c" })).ok).toBe(false); // ctrl-C is the PTY's
  });

  it("refuses ⌘C / ⌘V (reserved for copy/paste, trmx-66)", () => {
    expect(validateBinding(chord({ cmd: true, key: "c" })).ok).toBe(false);
    expect(validateBinding(chord({ cmd: true, key: "v" })).ok).toBe(false);
    // ⇧⌘C is not the copy chord, so it IS bindable.
    expect(validateBinding(chord({ cmd: true, shift: true, key: "c" }))).toEqual({ ok: true });
  });
});
