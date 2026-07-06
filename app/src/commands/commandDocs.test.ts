// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94 (FR-9.5): the doc-drift gate. `docs/commands.md` is a deterministic function of the registry
// + default keymap; this test regenerates it and asserts the committed file matches (the R9-gate
// pattern, run in the normal vitest suite). Run with `WRITE_COMMAND_DOCS=1` to (re)write the file.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCommandDocs } from "./commandDocs";
import { buildCommands, COMMAND_IDS } from "./registry";
import { FULL_DEFAULT_KEYS, mergeKeymap } from "./keymapDispatch";

// vitest runs from the `app/` package dir; docs/ lives at the repo root beside it.
const DOCS_PATH = resolve(process.cwd(), "../docs/commands.md");

describe("command docs generator (FR-9.5)", () => {
  const generated = renderCommandDocs(buildCommands(), mergeKeymap(FULL_DEFAULT_KEYS, []).keymap);

  it("renders every command id with its default binding", () => {
    for (const id of COMMAND_IDS) expect(generated).toContain(`\`${id}\``);
    expect(generated).toContain("`cmd+shift+p`"); // the palette's default binding is documented
    expect(generated).toContain("Command reference");
  });

  it("matches the committed docs/commands.md (regenerate with WRITE_COMMAND_DOCS=1)", () => {
    if (process.env.WRITE_COMMAND_DOCS) {
      writeFileSync(DOCS_PATH, generated);
    }
    const committed = readFileSync(DOCS_PATH, "utf8");
    expect(committed).toBe(generated);
  });
});
