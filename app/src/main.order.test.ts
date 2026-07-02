// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53 (plan D7): the no-flash startup paint must run SYNCHRONOUSLY at module evaluation,
// before boot()'s first await (`realInvoke("smoke_config")`) opens an async gap during which the
// static CSS fallback would show. main.tsx cannot be imported under jsdom (it boots the real
// app), so this is a source-order guard over the raw text: the behavioral coverage lives in
// applyStartupTheme.test.ts, and the real-browser proof in the Playwright e2e suite.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "./main.tsx"),
  "utf8",
);

describe("main.tsx startup ordering (trmx-53 D7)", () => {
  it("invokes applyStartupTheme at module level, outside boot()", () => {
    // The call must exist…
    const callIndex = source.indexOf("applyStartupTheme(");
    expect(callIndex).toBeGreaterThan(-1);
    // …and NOT inside boot()'s body (between "async function boot" and the invocation of boot).
    const bootStart = source.indexOf("async function boot");
    const bootInvoke = source.indexOf("void boot()");
    expect(bootStart).toBeGreaterThan(-1);
    expect(bootInvoke).toBeGreaterThan(-1);
    expect(callIndex < bootStart || callIndex > bootInvoke).toBe(true);
  });

  it("runs before boot() is invoked and before the smoke_config await", () => {
    const callIndex = source.indexOf("applyStartupTheme(");
    // Module statements execute top-to-bottom: the paint precedes `void boot()` in source order,
    // so it precedes boot()'s first await at runtime.
    expect(callIndex).toBeLessThan(source.indexOf("void boot()"));
    expect(source.indexOf("smoke_config")).toBeGreaterThan(-1);
  });
});
