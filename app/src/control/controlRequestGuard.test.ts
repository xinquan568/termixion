// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-237 (grill H3): the control-channel payload guard. `App.tsx` used to CAST the event payload
// (`payload as ControlRequest`) and immediately destructure `{ id, request }` from it, so a malformed
// payload — `null` above all — threw inside the event listener and escaped into React. The control socket
// is reachable by any local `termixion ctl` caller, which made "crash the terminal's UI" a thing a
// misbehaving client could do by accident. Validate at the edge; drop what does not fit.
import { describe, expect, it } from "vitest";
import { isControlRequest } from "./controlRequestGuard";

describe("isControlRequest (trmx-237 H3)", () => {
  it("accepts a well-formed request", () => {
    expect(isControlRequest({ id: 1, request: { cmd: "tab.new", args: {} } })).toBe(true);
  });

  it("accepts a request whose optional members are absent", () => {
    // `cmd`/`args` are `unknown` by design — routeControlRequest owns their validation.
    expect(isControlRequest({ id: 7, request: {} })).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "tab.new"],
    ["a number", 42],
    ["an array", [1, 2]],
    ["a missing request", { id: 1 }],
    ["a null request", { id: 1, request: null }],
    ["a non-object request", { id: 1, request: "tab.new" }],
    ["a missing id", { request: {} }],
    ["a non-numeric id", { id: "1", request: {} }],
    ["a NaN id", { id: Number.NaN, request: {} }],
  ])("rejects %s without throwing", (_label, payload) => {
    expect(isControlRequest(payload)).toBe(false);
  });
});
