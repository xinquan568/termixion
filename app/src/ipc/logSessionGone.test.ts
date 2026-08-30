// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-249. Nothing in this repo asserted a LOG LEVEL before this file, so the whole suite could go
// green while the demotion silently regressed. That is the point of these tests: the benefit of the
// change is the absence of an error-level record, and absence is only real if something checks it.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { logSessionGone } from "./useBackend";
import { log } from "./logSink";

const spies = {
  error: vi.spyOn(log, "error"),
  debug: vi.spyOn(log, "debug"),
};

beforeEach(() => {
  spies.error.mockImplementation(() => {});
  spies.debug.mockImplementation(() => {});
});
afterEach(() => vi.clearAllMocks());

describe("logSessionGone (trmx-249)", () => {
  // Both benign kinds, on both call sites — a matrix, because the round-3 review noted that
  // covering only `not_found` on write leaves three of the four cases free to regress.
  const benign = ["not_found", "not_running"] as const;
  const contexts = ["pty write failed", "pty resize failed"] as const;

  for (const context of contexts) {
    for (const kind of benign) {
      it(`sends ${kind} on "${context}" to debug, never error`, () => {
        logSessionGone(context, { kind, message: "no session with id 7" });
        expect(spies.debug).toHaveBeenCalledTimes(1);
        expect(spies.error).not.toHaveBeenCalled();
      });
    }
  }

  // The other half of the contract: demoting the benign kinds must NOT quieten real failures.
  it.each([
    ["io", "could not create /x"],
    ["internal", "pty state poisoned"],
    ["spawn", "failed to spawn pty session: boom"],
    ["invalid_size", "invalid pty size: 0 rows x 0 cols (both must be nonzero)"],
  ])("keeps %s at error level", (kind, message) => {
    logSessionGone("pty write failed", { kind, message });
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(spies.debug).not.toHaveBeenCalled();
  });

  it("keeps a legacy bare-string rejection at error level", () => {
    // No kind means we cannot know it is benign, so it must stay loud.
    logSessionGone("pty write failed", "pty state poisoned");
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(spies.debug).not.toHaveBeenCalled();
  });

  it("preserves the message when demoting, so the trail is not lost", () => {
    logSessionGone("pty write failed", {
      kind: "not_found",
      message: "no session with id 7",
    });
    const [, detail] = spies.debug.mock.calls[0];
    expect((detail as Error).message).toBe("no session with id 7");
  });
});
