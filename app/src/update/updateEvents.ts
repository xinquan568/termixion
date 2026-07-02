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

const COMMAND_TYPES = new Set(["checkNow", "download", "restart", "skip", "setAutoCheck"]);

export function isUpdateStateBroadcast(p: unknown): p is UpdateStateBroadcast {
  if (typeof p !== "object" || p === null) return false;
  const c = p as Partial<UpdateStateBroadcast>;
  return (
    typeof c.source === "string" &&
    typeof c.state === "object" &&
    c.state !== null &&
    typeof (c.state as UpdateState).status === "string"
  );
}

export function isUpdateCommandEnvelope(p: unknown): p is UpdateCommandEnvelope {
  if (typeof p !== "object" || p === null) return false;
  const c = p as Partial<UpdateCommandEnvelope>;
  return (
    typeof c.source === "string" &&
    typeof c.cmd === "object" &&
    c.cmd !== null &&
    COMMAND_TYPES.has((c.cmd as UpdateCommand).type)
  );
}
