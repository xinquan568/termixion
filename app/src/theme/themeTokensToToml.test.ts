// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (FR-6, test-first): themeTokensToToml — the Duplicate serializer. Serializing the `night`
// tokens must yield the exact snake_case TOML grammar `parse_theme` accepts, so a duplicated built-in
// round-trips zero-warning. The shape-parity test reads the CORE's golden fixture
// (crates/termixion-core/tests/fixtures/theme-golden.toml — via node:fs, the pattern txCssVars.test.ts
// uses), extracts its section headers + keys, and asserts the serializer emits every one.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { themeTokensToToml } from "./themeTokensToToml";
import { night } from "./themes/night";

// The core parser's golden fixture — the authoritative grammar our output must match field-for-field.
const goldenToml = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../crates/termixion-core/tests/fixtures/theme-golden.toml",
  ),
  "utf8",
);

describe("themeTokensToToml", () => {
  const toml = themeTokensToToml(night);

  it("emits is_dark as a bare boolean (not a quoted string)", () => {
    expect(toml).toMatch(/^is_dark = true$/m);
    expect(toml).not.toMatch(/is_dark = "true"/);
  });

  it("places the top-level is_dark before the first table header (valid TOML ordering)", () => {
    expect(toml.indexOf("is_dark")).toBeLessThan(toml.indexOf("["));
  });

  it("includes every section header the grammar defines", () => {
    for (const header of [
      "[color]",
      "[color.bg]",
      "[color.text]",
      "[color.accent]",
      "[color.semantic]",
      "[terminal]",
      "[terminal.ansi]",
      "[terminal.scrollbar]",
      "[terminal.pane]",
    ]) {
      expect(toml).toContain(header);
    }
  });

  it("renames camelCase token keys to the fixture's snake_case", () => {
    expect(toml).toMatch(/^bright_black = /m);
    expect(toml).toMatch(/^error_bg = /m);
    expect(toml).toMatch(/^cursor_accent = /m);
    expect(toml).toMatch(/^selection_background = /m);
    expect(toml).toMatch(/^active_border = /m);
    expect(toml).toMatch(/^inactive_border = /m);
    // …and never leaks a camelCase token key.
    expect(toml).not.toMatch(/brightBlack|errorBg|cursorAccent|selectionBackground|activeBorder|inactiveBorder|isDark/);
  });

  it("quotes color strings and preserves an rgba value verbatim", () => {
    expect(toml).toContain('primary = "#23262b"'); // hex, quoted
    expect(toml).toContain('bright_black = "#6e7681"'); // the trmx-77 bright-black
    expect(toml).toContain('idle = "rgba(255, 255, 255, 0.12)"'); // rgba() preserved verbatim
  });

  it("emits the per-pane badge token under [terminal] (trmx-90)", () => {
    // A single-word `badge` key; night's built-in watermark preserved verbatim
    // (trmx-149: Termixion's default badge pink #ff8da1).
    expect(toml).toMatch(/^badge = "#ff8da1"$/m);
    // …and it sits inside [terminal], before the [terminal.ansi] table opens.
    expect(toml.indexOf("[terminal]")).toBeLessThan(toml.indexOf("badge = "));
    expect(toml.indexOf("badge = ")).toBeLessThan(toml.indexOf("[terminal.ansi]"));
  });

  it("names the source built-in in the header comment when given", () => {
    const labeled = themeTokensToToml(night, "Night");
    expect(labeled.split("\n")[0]).toBe(
      "# Termixion theme — duplicated from Night; edit freely. See docs/themes.md",
    );
  });

  it("still emits a header comment when no source label is given", () => {
    expect(toml.split("\n")[0].startsWith("# ")).toBe(true);
  });

  it("shape parity: emits every section header + key the core golden fixture carries", () => {
    // Parse the fixture into its section headers ([a.b]) and bare keys (key = …), skipping comments.
    const sections: string[] = [];
    const keys: string[] = [];
    for (const raw of goldenToml.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const section = /^\[[^\]]+\]$/.exec(line);
      if (section) {
        sections.push(section[0]);
        continue;
      }
      const key = /^([A-Za-z0-9_]+)\s*=/.exec(line);
      if (key) keys.push(key[1]);
    }

    // Sanity: the fixture actually had structure to compare against.
    expect(sections).toContain("[terminal.ansi]");
    expect(keys).toContain("is_dark");
    expect(keys).toContain("bright_white");

    for (const section of sections) expect(toml).toContain(section);
    for (const key of keys) {
      // The key must appear at the start of some emitted line (its own `key = …` assignment).
      expect(toml).toMatch(new RegExp(`^${key}\\s*=`, "m"));
    }
  });
});
