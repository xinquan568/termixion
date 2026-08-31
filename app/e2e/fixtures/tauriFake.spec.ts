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

const independentIpcGolden = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../crates/termixion-tauri/tests/fixtures/ipc-error-golden.json",
    ),
    "utf8",
  ),
) as { sample: { kind: string; message: string }; vocabulary: string[] };

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
    // ALL FOUR. Covering only two left a hole: repointing the fixture at an app-side copy with a
    // stale shellsList or effectiveShell would have satisfied every other test here.
    expect(commandGolden.configRead).toEqual(rustGolden.configRead);
    expect(commandGolden.shellsList).toEqual(rustGolden.shellsList);
    expect(commandGolden.effectiveShell).toEqual(rustGolden.effectiveShell);
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
    // DEEP-EQUAL the entire caught value against an independently loaded golden. Membership plus a
    // message substring would leave an IpcError field change green, which is what this replaces.
    expect(rejection.err).toEqual(independentIpcGolden.sample);
    // The command name lives in the call log, not smuggled into the message where it would break
    // the equality above.
    const calls = await fakeCalls(page);
    expect(calls.some((c) => c.cmd === "no_such_command" && !c.ok)).toBe(true);
  });

  test("records the exact commands and arguments invoked", async ({ page }) => {
    await installTauriFake(page);
    await page.goto("/");
    // A VALID call: config_read takes no arguments, so probing it with a payload is now rejected
    // (that is F1's whole point). log_message carries a real declared payload to record.
    await page.evaluate(() =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke("log_message", { level: "warn", message: "probe" }),
    );
    const calls = await fakeCalls(page);
    const logged = calls.filter((c) => c.cmd === "log_message");
    expect(logged.length).toBeGreaterThan(0);
    expect(logged[logged.length - 1].args).toEqual({ level: "warn", message: "probe" });
    expect(logged[logged.length - 1].ok).toBe(true);
    // The app's own boot call is evidence the fake is wired into the real app path, not just callable.
    expect(calls.some((c) => c.cmd === "config_read")).toBe(true);
  });

  test("keeps state isolated per page — a sentinel never leaks into a second context", async ({
    browser,
  }) => {
    // Two independently installed contexts inside ONE test, so isolation is exercised rather than
    // assumed. The previous version asserted the absence of a command another parallel test may or
    // may not have run — it could pass without proving anything.
    const first = await browser.newContext();
    const firstPage = await first.newPage();
    await installTauriFake(firstPage);
    await firstPage.goto("/");
    await firstPage
      .evaluate(() =>
        (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (c: string) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke("sentinel_command").catch(() => null),
      )
      .catch(() => null);

    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await installTauriFake(secondPage);
    await secondPage.goto("/");

    expect((await fakeCalls(firstPage)).some((c) => c.cmd === "sentinel_command")).toBe(true);
    expect((await fakeCalls(secondPage)).some((c) => c.cmd === "sentinel_command")).toBe(false);
    await first.close();
    await second.close();
  });

  test("REJECTS a known command called with arguments it does not take", async ({ page }) => {
    // T7: answering any payload hides frontend argument drift. config_read takes none.
    await installTauriFake(page);
    await page.goto("/");
    const outcome = await page.evaluate(async () => {
      try {
        await (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke("config_read", { unexpected: true });
        return { rejected: false };
      } catch (err) {
        return { rejected: true, err: err as unknown };
      }
    });
    expect(outcome.rejected).toBe(true);
    expect(outcome.err).toEqual(independentIpcGolden.sample);
  });

  test("ACCEPTS a known command called with its declared arguments", async ({ page }) => {
    await installTauriFake(page);
    await page.goto("/");
    const ok = await page.evaluate(async () => {
      await (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke("log_message", { level: "info", message: "hello" });
      return true;
    });
    expect(ok).toBe(true);
  });

  test("REJECTS log_message with a malformed payload", async ({ page }) => {
    await installTauriFake(page);
    await page.goto("/");
    const rejected = await page.evaluate(async () => {
      try {
        await (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke("log_message", { level: 7 });
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toBe(true);
  });
});
