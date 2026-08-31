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
 * Per-command argument contracts (T7).
 *
 * Answering a known command with ANY payload hides frontend argument drift, so each command states
 * what it will accept. All four hydrating commands are zero-argument on the Rust side
 * (`config_read`, `shells_list`, `effective_shell`, `themes_read` take no user parameters), so a
 * caller passing anything is a caller that has drifted.
 */
export const ARG_CONTRACTS: Readonly<Record<string, "none" | "logMessage">> = {
  config_read: "none",
  shells_list: "none",
  effective_shell: "none",
  themes_read: "none",
  log_message: "logMessage",
};

/**
 * Install the fake **before navigation**. Installing after `page.goto` is too late: the app reads
 * `__TAURI_INTERNALS__` during boot, so the window must already carry it.
 *
 * The rejection is a clone of the Rust-asserted `IpcError` sample — verbatim, not rebuilt — so a
 * spec can deep-equal the whole caught value against the golden. The unhandled command name is not
 * smuggled into the message (that would break the equality); it is in the call log instead.
 */
export async function installTauriFake(page: Page): Promise<void> {
  await page.addInitScript(
    ({ responses, contracts, rejection }) => {
      const calls: { cmd: string; args: unknown; ok: boolean }[] = [];
      (window as unknown as Record<string, unknown>).__TAURI_FAKE_CALLS__ = calls;

      const argsOk = (contract: string, args: unknown): boolean => {
        if (contract === "none") {
          return args === undefined || args === null
            ? true
            : typeof args === "object" && Object.keys(args as object).length === 0;
        }
        if (contract === "logMessage") {
          if (args === null || typeof args !== "object") return false;
          const record = args as Record<string, unknown>;
          return typeof record.level === "string" && typeof record.message === "string";
        }
        return false;
      };

      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
        transformCallback: () => 0,
        invoke: (cmd: string, args: unknown) => {
          const contract = contracts[cmd];
          const known = Object.prototype.hasOwnProperty.call(responses, cmd) || contract !== undefined;
          const ok = known && argsOk(contract ?? "none", args);
          calls.push({ cmd, args, ok });
          if (!ok) {
            // Unknown command, or a known one called with arguments it does not take. Both reject
            // with the exact golden payload — an over-permissive fake hides a real caller bug.
            return Promise.reject({ ...rejection });
          }
          if (Object.prototype.hasOwnProperty.call(responses, cmd)) {
            return Promise.resolve(responses[cmd]);
          }
          return Promise.resolve(null);
        },
      };
    },
    {
      responses: FAKE_RESPONSES as Record<string, unknown>,
      contracts: ARG_CONTRACTS as Record<string, string>,
      rejection: ipcErrorGolden.sample,
    },
  );
}

/** Every `invoke` the page has made, in order, with whether the fake accepted it. */
export async function fakeCalls(
  page: Page,
): Promise<{ cmd: string; args: unknown; ok: boolean }[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __TAURI_FAKE_CALLS__?: { cmd: string; args: unknown; ok: boolean }[];
        }
      ).__TAURI_FAKE_CALLS__ ?? [],
  );
}
