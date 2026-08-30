// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-249: the cross-language half of the IPC rejection contract.
//
// This reads the SAME file the Rust suite asserts — crates/termixion-tauri/tests/fixtures/
// ipc-error-golden.json — not a copy under app/. The trmx-89 precedent is explicit about why:
// app/src/theme/themeSpecGolden.test.ts:7 records that a local copy was deleted because a comment
// claiming two files "MUST stay in sync" cannot enforce anything. One file, two readers.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { IPC_ERROR_KINDS, decodeIpcError } from "./ipcError";

// readFileSync against the Rust tree, the shape themeSpecGolden.test.ts already proves resolves.
const golden = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../crates/termixion-tauri/tests/fixtures/ipc-error-golden.json",
    ),
    "utf8",
  ),
) as { sample: { kind: string; message: string }; vocabulary: string[] };

describe("ipc-error golden (shared with the Rust suite)", () => {
  it("agrees with Rust on the complete kind vocabulary", () => {
    // Exact, ordered comparison. A variant added in Rust extends the fixture's vocabulary (its ALL
    // is compiler-enforced exhaustive) and fails here until IPC_ERROR_KINDS is extended too.
    expect([...IPC_ERROR_KINDS]).toEqual(golden.vocabulary);
  });

  it("decodes the exact payload Rust produces at the boundary", () => {
    const error = decodeIpcError(golden.sample);
    expect(error.kind).toBe(golden.sample.kind);
    expect(error.message).toBe(golden.sample.message);
    expect(String(error)).not.toContain("[object Object]");
  });

  it("pins the sample as a two-field object, so a field added in Rust is noticed", () => {
    expect(Object.keys(golden.sample).sort()).toEqual(["kind", "message"]);
  });
});
