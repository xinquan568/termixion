// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94 (FR-9.5): the command reference generator. `docs/commands.md` is a DETERMINISTIC function of
// the registry + the default keymap, so it can't drift — `commandDocs.test.ts` regenerates and diffs
// it in the normal vitest suite (CI runs vitest), the R9-gate pattern. Pure (no fs); the test owns I/O.
import type { Command } from "./registry";

/** The default binding (canonical chord) for a command id, or "" — reverse-looks-up the default map. */
function defaultBinding(id: string, keymap: Readonly<Record<string, string>>): string {
  for (const [chord, command] of Object.entries(keymap)) {
    if (command === id) return chord;
  }
  return "";
}

/**
 * Render the command reference as Markdown: a header + a table of every command (id, title, category,
 * default binding). Deterministic — registry order, no timestamps — so the committed file is a stable
 * function of the code.
 */
export function renderCommandDocs(
  commands: Command[],
  keymap: Readonly<Record<string, string>>,
): string {
  const rows = commands
    .map((c) => `| \`${c.id}\` | ${c.title} | ${c.category} | ${binding(defaultBinding(c.id, keymap))} |`)
    .join("\n");
  return `# Command reference (FR-9)

Every user-facing action is a named internal command (trmx-94). Open the **command palette** with
\`⇧⌘P\` to fuzzy-find and run any of them by keyboard, or rebind any chord in the \`[keys]\` table of
\`termixion.toml\` (see [config.md](config.md); \`= "none"\` unbinds a default). Commands ending in \`…\`
open a second picker (a theme / a script).

> This file is generated from the command registry — do not edit by hand. It is regenerated and
> diffed by \`app/src/commands/commandDocs.test.ts\` (run \`WRITE_COMMAND_DOCS=1\` on that test to update).

| Command ID | Title | Category | Default binding |
| ---------- | ----- | -------- | --------------- |
${rows}
`;
}

/** A binding cell: the chord in code font, or an em dash for the palette-only commands. */
function binding(chord: string): string {
  return chord === "" ? "—" : `\`${chord}\``;
}
