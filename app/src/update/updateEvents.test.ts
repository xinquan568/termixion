// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51 (step-9 review fix): bus payloads are UNTRUSTED input — the guards must be value-strict,
// not just shape-shallow. A command like {type:"setAutoCheck", enabled:"false"} (string, truthy!)
// or a snapshot with a bogus status/non-boolean autoCheckEnabled must be rejected wholesale, never
// executed or applied. R8: these are the failing tests for the hardened contract.
import { describe, expect, it } from "vitest";
import { isUpdateCommandEnvelope, isUpdateStateBroadcast } from "./updateEvents";
import { initialUpdateState } from "./updateState";

const VALID_STATE = {
  state: { ...initialUpdateState(true) },
  source: "main",
};

describe("isUpdateStateBroadcast (value-strict)", () => {
  it("accepts real snapshots — bare, with updateInfo, with progress", () => {
    expect(isUpdateStateBroadcast(VALID_STATE)).toBe(true);
    expect(
      isUpdateStateBroadcast({
        state: {
          status: "available",
          autoCheckEnabled: true,
          updateInfo: { version: "0.0.2", currentVersion: "0.0.1", notes: "n", date: "2026-07-02" },
        },
        source: "main",
      }),
    ).toBe(true);
    expect(
      isUpdateStateBroadcast({
        state: {
          status: "downloading",
          autoCheckEnabled: false,
          updateInfo: { version: "0.0.2" },
          progress: { downloaded: 10, total: 100 },
        },
        source: "main",
      }),
    ).toBe(true);
    expect(
      isUpdateStateBroadcast({
        state: { status: "error", autoCheckEnabled: true, error: "offline" },
        source: "main",
      }),
    ).toBe(true);
  });

  it("rejects an unknown status even though it is a string", () => {
    expect(
      isUpdateStateBroadcast({
        state: { status: "pwned", autoCheckEnabled: true },
        source: "main",
      }),
    ).toBe(false);
  });

  it("rejects a non-boolean autoCheckEnabled", () => {
    expect(
      isUpdateStateBroadcast({
        state: { status: "idle", autoCheckEnabled: "true" },
        source: "main",
      }),
    ).toBe(false);
  });

  it("rejects malformed nested updateInfo / progress / error fields", () => {
    expect(
      isUpdateStateBroadcast({
        state: { status: "available", autoCheckEnabled: true, updateInfo: { version: 2 } },
        source: "main",
      }),
    ).toBe(false);
    expect(
      isUpdateStateBroadcast({
        state: { status: "available", autoCheckEnabled: true, updateInfo: "0.0.2" },
        source: "main",
      }),
    ).toBe(false);
    expect(
      isUpdateStateBroadcast({
        state: {
          status: "downloading",
          autoCheckEnabled: true,
          updateInfo: { version: "0.0.2" },
          progress: { downloaded: "10" },
        },
        source: "main",
      }),
    ).toBe(false);
    expect(
      isUpdateStateBroadcast({
        state: { status: "error", autoCheckEnabled: true, error: 500 },
        source: "main",
      }),
    ).toBe(false);
    expect(
      isUpdateStateBroadcast({
        state: { status: "idle", autoCheckEnabled: true, dismissedVersion: 1 },
        source: "main",
      }),
    ).toBe(false);
  });

  it("rejects missing source / null / junk", () => {
    expect(isUpdateStateBroadcast({ state: VALID_STATE.state })).toBe(false);
    expect(isUpdateStateBroadcast(null)).toBe(false);
    expect(isUpdateStateBroadcast("junk")).toBe(false);
    expect(isUpdateStateBroadcast({ garbage: true })).toBe(false);
  });
});

describe("isUpdateCommandEnvelope (value-strict)", () => {
  it("accepts the five real commands", () => {
    for (const cmd of [
      { type: "checkNow" },
      { type: "download" },
      { type: "restart" },
      { type: "skip" },
      { type: "setAutoCheck", enabled: false },
    ]) {
      expect(isUpdateCommandEnvelope({ cmd, source: "settings" })).toBe(true);
    }
  });

  it("rejects setAutoCheck whose enabled is not a real boolean (the truthy-string attack)", () => {
    expect(
      isUpdateCommandEnvelope({
        cmd: { type: "setAutoCheck", enabled: "false" },
        source: "settings",
      }),
    ).toBe(false);
    expect(
      isUpdateCommandEnvelope({ cmd: { type: "setAutoCheck" }, source: "settings" }),
    ).toBe(false);
    expect(
      isUpdateCommandEnvelope({ cmd: { type: "setAutoCheck", enabled: 1 }, source: "settings" }),
    ).toBe(false);
  });

  it("rejects unknown types, missing source, and junk", () => {
    expect(isUpdateCommandEnvelope({ cmd: { type: "explode" }, source: "settings" })).toBe(false);
    expect(isUpdateCommandEnvelope({ cmd: { type: "download" } })).toBe(false);
    expect(isUpdateCommandEnvelope(null)).toBe(false);
    expect(isUpdateCommandEnvelope({ nonsense: true })).toBe(false);
  });
});
