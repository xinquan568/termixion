// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-236 (grill H1): the webview's diagnostic sink. A packaged app's WKWebView console is unreachable
// without Web Inspector, so every `error` / `warn` / `info` diagnostic is (1) still written to the console
// — the developer experience is unchanged — and (2) forwarded, best-effort, to the backend's log file
// through the app-owned `log_message` command (bounded and level-checked on the Rust side). Logging must
// never throw and never reject: a forwarding failure is swallowed. `debug` stays local by policy.
//
// What is NEVER forwarded: PTY input/output, environment values, clipboard contents, `send-text`
// payloads (R5; docs/CONTRIBUTING.md "Logging"). Call sites pass a short context and an error / value.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/** The forwarded levels (the Rust side also accepts debug/trace, but the policy keeps those local). */
export type LogLevel = "error" | "warn" | "info";

/** The invoke seam — production wires `@tauri-apps/api/core`'s invoke; tests inject a recorder. */
export type LogInvoke = (
  cmd: "log_message",
  args: { level: LogLevel; message: string },
) => Promise<unknown> | unknown;

export interface LogSink {
  error(context: string, detail?: unknown): void;
  warn(context: string, detail?: unknown): void;
  info(context: string, detail?: unknown): void;
  /**
   * LOCAL ONLY — written to the console, never forwarded to the backend log file (trmx-249).
   *
   * Deliberately absent from {@link LogLevel}: that type is the set of levels that GO TO THE FILE,
   * and the trmx-236 policy keeps debug in the webview. Used for outcomes that are expected rather
   * than wrong — a PTY write to a session that has already closed — where `error` was a false alarm
   * and silence would lose the trail.
   */
  debug(context: string, detail?: unknown): void;
}

/** Render a detail value compactly: an Error's message, a string as-is, anything else as JSON. */
export function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (detail instanceof Error) return detail.message;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    try {
      return String(detail);
    } catch {
      return "<unprintable detail>"; // a hostile toJSON + Symbol.toPrimitive: logging still never throws
    }
  }
}

/** The one line that goes to both the console and the file: `[termixion] <context>: <detail>`. */
export function formatRecord(context: string, detail?: unknown): string {
  const d = formatDetail(detail);
  return d ? `[termixion] ${context}: ${d}` : `[termixion] ${context}`;
}

type ConsoleLike = Pick<Console, "error" | "warn" | "info" | "debug">;

/** Build a sink over an invoke seam and a console (both injectable for tests). */
export function makeLogSink(invoke: LogInvoke, console_: ConsoleLike = console): LogSink {
  const forward = (level: LogLevel, message: string): void => {
    try {
      const result = invoke("log_message", { level, message });
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(() => {
          /* best-effort: a missing runtime or a rejected command never surfaces */
        });
      }
    } catch {
      /* a synchronously throwing invoke (no Tauri runtime) is equally ignored */
    }
  };
  return {
    error(context, detail) {
      const line = formatRecord(context, detail);
      console_.error(line);
      forward("error", line);
    },
    warn(context, detail) {
      const line = formatRecord(context, detail);
      console_.warn(line);
      forward("warn", line);
    },
    info(context, detail) {
      const line = formatRecord(context, detail);
      console_.info(line);
      forward("info", line);
    },
    debug(context, detail) {
      // No `forward` call, and that is the whole point — see the LogSink.debug doc comment.
      console_.debug(formatRecord(context, detail));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The production sink. `ipc/` is the sanctioned Tauri-API edge (M7 layering), so the real invoke lives
// here; every other module imports `log` and never touches `@tauri-apps/api` for diagnostics.
// ---------------------------------------------------------------------------------------------
/** The app-wide diagnostic sink (console + backend log file). */
export const log: LogSink = makeLogSink((cmd, args) => tauriInvoke(cmd, args));
