// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-237 (grill H3): validate the control-channel event payload at the edge. The socket is reachable by
// any local `termixion ctl` caller, and App.tsx used to cast-and-destructure the payload — so a malformed
// one threw inside the listener and escaped into React, taking the UI down. Shape only: `cmd`/`args` stay
// `unknown` because `routeControlRequest` owns their validation and answers a bad command properly.

/** The shape App.tsx destructures: a numeric correlation id and a request object. */
export type ControlRequest = { id: number; request: { cmd?: unknown; args?: unknown } };

/** True when `payload` can be safely destructured as a `ControlRequest`. Never throws. */
export function isControlRequest(payload: unknown): payload is ControlRequest {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const { id, request } = payload as { id?: unknown; request?: unknown };
  if (typeof id !== "number" || Number.isNaN(id)) return false;
  return typeof request === "object" && request !== null && !Array.isArray(request);
}
