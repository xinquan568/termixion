// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-247: the `session:activity` wire payload and its parser. These are TRANSPORT concerns — the
// shape the backend emits and the guard that validates it — so they live in `ipc/`, which imports
// nothing above itself. `panes/activityLine.ts` consumes ActivityMeta from here, which is why
// `panes/` is a layer above `ipc/` rather than a leaf.

/** trmx-159: the classification metadata the poller carries on a busy rise (each field independent). */
export interface ActivityMeta {
  readonly name?: string;
  readonly args?: string[];
  readonly stdinTty?: boolean;
}

/**
 * Guard for the `session:activity` event payload (untrusted, like cursorSettings.ts): a valid
 * `{ sessionId, busy }` with an integer `sessionId` (a backend session handle — NaN / +-Infinity /
 * fractional are junk) and a boolean `busy`. trmx-159: also parses the OPTIONAL rise metadata
 * (`foregroundName`/`foregroundArgs`/`foregroundStdinTty`), each validated independently and dropped
 * if junk, into `meta` (absent when no metadata is present). Anything invalid at the core yields null.
 */
export function parseActivityPayload(
  payload: unknown,
): { sessionId: number; busy: boolean; meta?: ActivityMeta } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const {
    sessionId,
    busy,
    foregroundName,
    foregroundArgs,
    foregroundStdinTty,
  } = payload as {
    sessionId?: unknown;
    busy?: unknown;
    foregroundName?: unknown;
    foregroundArgs?: unknown;
    foregroundStdinTty?: unknown;
  };
  // review-1: the SAME positive-safe-integer guard the other session ingress points use (ipc/backend
  // isSessionId) — the backend allocates positive u64 handles, so 0 / negative / unsafe are junk.
  if (typeof sessionId !== "number" || !Number.isSafeInteger(sessionId) || sessionId <= 0) return null;
  if (typeof busy !== "boolean") return null;

  const meta: { name?: string; args?: string[]; stdinTty?: boolean } = {};
  if (typeof foregroundName === "string") meta.name = foregroundName;
  if (Array.isArray(foregroundArgs) && foregroundArgs.every((a) => typeof a === "string")) {
    meta.args = foregroundArgs as string[];
  }
  if (typeof foregroundStdinTty === "boolean") meta.stdinTty = foregroundStdinTty;

  return Object.keys(meta).length > 0
    ? { sessionId, busy, meta }
    : { sessionId, busy };
}
