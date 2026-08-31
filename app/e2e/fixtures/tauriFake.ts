// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-251: a fake Tauri runtime for the Playwright suite.
//
// 18 of the 19 specs load `/` with no `__TAURI_INTERNALS__` at all, so every `invoke` rejects and
// they assert the DEGRADED surface. That pins real fail-soft contracts and is worth keeping — but it
// means the HYDRATED surface, which is what users actually see, is almost untested end to end.
//
// The danger in fixing that is a fake which drifts from the real wire shape: it then asserts green
// against a contract the backend no longer honours, which is worse than no coverage. So the
// responses are NOT written here. They are read from
// `crates/termixion-tauri/tests/fixtures/command-responses-golden.json`, the same file the Rust
// suite asserts against real serde output. There is deliberately no copy under `app/` —
// `app/src/theme/themeSpecGolden.test.ts:7` records that such a copy had already drifted while a
// comment claimed the two "MUST NOT", which is exactly the pattern this replaces.
//
// This is a plain helper, not an auto-applied fixture on an extended `test`. A spec opts out by not
// calling it — which is how the degraded-mode specs keep working, and why no opt-out mechanism is
// needed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Page } from "@playwright/test";

/** The Rust-asserted command-response contract. */
export interface CommandGolden {
  configRead: unknown;
  shellsList: unknown;
  effectiveShell: unknown;
  themesRead: unknown;
}

/** The rejection contract (trmx-249), asserted on the Rust side from a real `InvokeError`. */
export interface IpcErrorGolden {
  sample: { kind: string; message: string };
  vocabulary: string[];
}

function readGolden<T>(relative: string): T {
  return JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), relative), "utf8"),
  ) as T;
}

export const commandGolden = readGolden<CommandGolden>(
  "../../../crates/termixion-tauri/tests/fixtures/command-responses-golden.json",
);

export const ipcErrorGolden = readGolden<IpcErrorGolden>(
  "../../../crates/termixion-tauri/tests/fixtures/ipc-error-golden.json",
);

/**
 * The commands the fake answers, mapped to their golden section.
 *
 * Deliberately small: a fake that answers everything hides a caller invoking something the backend
 * does not implement. Anything not listed here REJECTS.
 */
export const FAKE_RESPONSES: Readonly<Record<string, unknown>> = {
  config_read: commandGolden.configRead,
  shells_list: commandGolden.shellsList,
  effective_shell: commandGolden.effectiveShell,
  themes_read: commandGolden.themesRead,
};

/** Commands the fake accepts with no meaningful payload — fire-and-forget sinks. */
export const FAKE_ACCEPTED_VOID: readonly string[] = ["log_message"];

/**
 * Install the fake **before navigation**. Installing after `page.goto` is too late: the app reads
 * `__TAURI_INTERNALS__` during boot, so the window must already carry it.
 *
 * The rejection shape matches the real backend's typed `IpcError` (trmx-249) rather than a bare
 * string, so a spec exercising a failure path sees what production sends.
 */
export async function installTauriFake(page: Page): Promise<void> {
  await page.addInitScript(
    ({ responses, acceptedVoid, rejectionKind }) => {
      const calls: { cmd: string; args: unknown }[] = [];
      (window as unknown as Record<string, unknown>).__TAURI_FAKE_CALLS__ = calls;
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        transformCallback: () => 0,
        invoke: (cmd: string, args: unknown) => {
          calls.push({ cmd, args });
          if (Object.prototype.hasOwnProperty.call(responses, cmd)) {
            return Promise.resolve(responses[cmd]);
          }
          if (acceptedVoid.includes(cmd)) return Promise.resolve(null);
          // An unhandled command rejects in the backend's typed shape, naming the command so the
          // failure says what is missing rather than just that something is.
          return Promise.reject({
            kind: rejectionKind,
            message: `e2e fake backend: unhandled command ${cmd}`,
          });
        },
      };
    },
    {
      responses: FAKE_RESPONSES as Record<string, unknown>,
      acceptedVoid: [...FAKE_ACCEPTED_VOID],
      // "not_found" is the real vocabulary's term for "the backend has no such thing".
      rejectionKind: ipcErrorGolden.vocabulary.includes("not_found")
        ? "not_found"
        : ipcErrorGolden.vocabulary[0],
    },
  );
}

/** Every `invoke` the page has made, in order — for asserting exact arguments. */
export async function fakeCalls(page: Page): Promise<{ cmd: string; args: unknown }[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __TAURI_FAKE_CALLS__?: { cmd: string; args: unknown }[] })
        .__TAURI_FAKE_CALLS__ ?? [],
  );
}
