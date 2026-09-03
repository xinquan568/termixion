// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-250 (L10, T4.3): the ONE textual assertion left over main.tsx, and why it is textual.
//
// main.tsx cannot be imported under jsdom — evaluating it boots the real app (createRoot on
// `#root`, the backend gates, the terminal pipeline). Everything it used to do is now boot.tsx,
// which boot.test.tsx EXECUTES against a recorder; what remains in main.tsx is a `BootDeps`
// object of real implementations and a single `start` call. That call is the irreducible residue:
// it can only be observed by reading the file, so it is read — through Vite's `?raw` loader, the
// file's TEXT and never its module — and nothing else about main.tsx is pinned this way.
import { describe, expect, it } from "vitest";
import source from "./main.tsx?raw";

describe("main.tsx is a shim over boot.tsx (trmx-250 T4.3)", () => {
  it("calls start exactly once, receiving realBootDeps", () => {
    // `\bstart\(` — the call, not the import (`{ start, type BootDeps }`) and not prose.
    expect(source.match(/\bstart\(/g)).toHaveLength(1);
    expect(source).toMatch(/\bstart\(realBootDeps\)/);
  });
});
