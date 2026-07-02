// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the update-sync wire contract between the MAIN window (the authority — owns the real
// state machine and the PendingUpdate handle) and the settings window (a projection). Snapshots
// are full states, so late subscribers converge from any point; commands carry a source tag so the
// authority never executes its own echo. Payload guards keep malformed events inert (events are
// untrusted input).
import type { UpdateState } from "./updateState";

/** Authority → everyone: the full current UpdateState (idempotent snapshot). */
export const UPDATE_STATE_EVENT = "update:state";
/** Projection → authority: please broadcast a snapshot now (sent on mount). */
export const UPDATE_REQUEST_STATE_EVENT = "update:request-state";
/** Projection → authority: execute a manual action on the real machine. */
export const UPDATE_COMMAND_EVENT = "update:command";

export interface UpdateStateBroadcast {
  state: UpdateState;
  source: string;
}

export type UpdateCommand =
  | { type: "checkNow" }
  | { type: "download" }
  | { type: "restart" }
  | { type: "skip" }
  | { type: "setAutoCheck"; enabled: boolean };

export interface UpdateCommandEnvelope {
  cmd: UpdateCommand;
  source: string;
}

// Value-strict validation (step-9 review fix): payloads are untrusted; a known type string is not
// enough. Every field a consumer would act on is checked — a truthy-string `enabled: "false"` or a
// bogus status must be rejected wholesale, never executed or applied.

const UPDATE_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "ready",
  "error",
]);

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

function isValidUpdateInfo(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== "object" || v === null) return false;
  const i = v as { version?: unknown; currentVersion?: unknown; notes?: unknown; date?: unknown };
  return (
    typeof i.version === "string" &&
    isOptionalString(i.currentVersion) &&
    isOptionalString(i.notes) &&
    isOptionalString(i.date)
  );
}

function isValidProgress(v: unknown): boolean {
  if (v === undefined) return true;
  if (typeof v !== "object" || v === null) return false;
  const p = v as { downloaded?: unknown; total?: unknown };
  return (
    typeof p.downloaded === "number" &&
    Number.isFinite(p.downloaded) &&
    (p.total === undefined || (typeof p.total === "number" && Number.isFinite(p.total)))
  );
}

export function isUpdateStateBroadcast(p: unknown): p is UpdateStateBroadcast {
  if (typeof p !== "object" || p === null) return false;
  const c = p as Partial<UpdateStateBroadcast>;
  if (typeof c.source !== "string") return false;
  if (typeof c.state !== "object" || c.state === null) return false;
  const s = c.state as Partial<UpdateState>;
  return (
    typeof s.status === "string" &&
    UPDATE_STATUSES.has(s.status) &&
    typeof s.autoCheckEnabled === "boolean" &&
    isValidUpdateInfo(s.updateInfo) &&
    isValidProgress(s.progress) &&
    isOptionalString(s.error) &&
    isOptionalString(s.dismissedVersion)
  );
}

export function isUpdateCommandEnvelope(p: unknown): p is UpdateCommandEnvelope {
  if (typeof p !== "object" || p === null) return false;
  const c = p as Partial<UpdateCommandEnvelope>;
  if (typeof c.source !== "string") return false;
  if (typeof c.cmd !== "object" || c.cmd === null) return false;
  const cmd = c.cmd as { type?: unknown; enabled?: unknown };
  switch (cmd.type) {
    case "checkNow":
    case "download":
    case "restart":
    case "skip":
      return true;
    case "setAutoCheck":
      return typeof cmd.enabled === "boolean";
    default:
      return false;
  }
}
