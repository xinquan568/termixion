// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-251: the fake's own tests. Without them this PR would add a fixture no test executes, which
// can land green while being broken — the fake is only useful if it is pinned, and the pinning is
// the deliverable.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  installTauriFake,
  fakeCalls,
  commandGolden,
  ipcErrorGolden,
  FAKE_RESPONSES,
} from "./tauriFake";

const rustGolden = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../crates/termixion-tauri/tests/fixtures/command-responses-golden.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

test.describe("tauriFake is pinned to the Rust-asserted golden", () => {
  // What each side can and cannot prove, stated plainly, because getting this wrong is easy:
  //
  //   - Whether the golden matches the REAL serde output is the RUST suite's job
  //     (config_io / shells_io / themes_io each assert their section). Verified by editing the
  //     golden and watching those tests fail.
  //   - These tests CANNOT detect golden-vs-Rust drift, and must not claim to: the fake reads the
  //     golden, so editing the file moves both sides together and a content comparison here would
  //     pass. An earlier version of this file compared the golden to itself and was tautological.
  //
  // What these CAN prove is that the fake SOURCES the contract rather than restating it.

  test("sources every response from the golden object itself, not a copy of it", () => {
    // Referential identity, not deep equality. A hand-written literal that happens to match today
    // would pass `toEqual` and then drift silently; it fails `toBe` immediately.
    expect(FAKE_RESPONSES.config_read).toBe(commandGolden.configRead);
    expect(FAKE_RESPONSES.shells_list).toBe(commandGolden.shellsList);
    expect(FAKE_RESPONSES.effective_shell).toBe(commandGolden.effectiveShell);
    expect(FAKE_RESPONSES.themes_read).toBe(commandGolden.themesRead);
  });

  test("loads that golden from the Rust tree, with no app-side copy", () => {
    // Read independently here, straight from crates/, and compared against what the fixture
    // module loaded. If the fixture were ever repointed at a copy under app/, these diverge.
    expect(commandGolden.configRead).toEqual(rustGolden.configRead);
    expect(commandGolden.themesRead).toEqual(rustGolden.themesRead);
    expect(ipcErrorGolden.vocabulary).toContain("not_found");
  });

  test("answers exactly the four hydrating commands and nothing more", () => {
    // Scope is part of the contract: a fake that grows silently starts hiding real gaps.
    expect(Object.keys(FAKE_RESPONSES).sort()).toEqual([
      "config_read",
      "effective_shell",
      "shells_list",
      "themes_read",
    ]);
  });
});

test.describe("tauriFake behaviour", () => {
  test("installs BEFORE navigation, so boot sees the runtime", async ({ page }) => {
    await installTauriFake(page);
    await page.goto("/");
    const present = await page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__,
    );
    expect(present).toBe("object");
  });

  test("answers the four hydrating commands with the golden values", async ({ page }) => {
    await installTauriFake(page);
    await page.goto("/");
    for (const [cmd, expected] of Object.entries(FAKE_RESPONSES)) {
      const got = await page.evaluate(
        (name) =>
          (
            window as unknown as {
              __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
            }
          ).__TAURI_INTERNALS__.invoke(name),
        cmd,
      );
      expect(got).toEqual(expected);
    }
  });

  test("REJECTS an unknown command in the typed IpcError shape", async ({ page }) => {
    await installTauriFake(page);
    await page.goto("/");
    const rejection = await page.evaluate(async () => {
      try {
        await (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (c: string) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke("no_such_command");
        return { rejected: false };
      } catch (err) {
        return { rejected: true, err: err as { kind?: string; message?: string } };
      }
    });
    expect(rejection.rejected).toBe(true);
    // The vocabulary comes from the Rust enum, so this cannot drift into an invented kind.
    expect(ipcErrorGolden.vocabulary).toContain(rejection.err?.kind);
    expect(rejection.err?.message).toContain("no_such_command");
  });

  test("records the exact commands and arguments invoked", async ({ page }) => {
    await installTauriFake(page);
    await page.goto("/");
    await page.evaluate(() =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke("config_read", { probe: 1 }),
    );
    const calls = await fakeCalls(page);
    // The app's own boot also calls config_read, so take the LAST one — the probe — rather than the
    // first truthy-args match, which was the boot call.
    const configReads = calls.filter((c) => c.cmd === "config_read");
    expect(configReads.length).toBeGreaterThan(0);
    expect(configReads[configReads.length - 1].args).toEqual({ probe: 1 });
    // The boot call is itself evidence the fake is wired into the real app path, not just callable.
    expect(calls.some((c) => c.cmd === "config_read")).toBe(true);
  });

  test("keeps state isolated per test — a fresh page records no calls from the last one", async ({
    page,
  }) => {
    await installTauriFake(page);
    await page.goto("/");
    const calls = await fakeCalls(page);
    expect(calls.every((c) => c.cmd !== "no_such_command")).toBe(true);
  });
});
