// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the update state machine spec — every transition of the auto-update flow, driven purely.
import { describe, expect, it } from "vitest";
import {
  initialUpdateState,
  isCardVisible,
  progressPercent,
  updateReducer,
  type UpdateInfo,
  type UpdateState,
} from "./updateState";

const INFO: UpdateInfo = { version: "0.0.2", currentVersion: "0.0.1", notes: "Fixes", date: "2026-07-02" };

function at(status: UpdateState["status"], extra: Partial<UpdateState> = {}): UpdateState {
  return { status, autoCheckEnabled: true, ...extra };
}

describe("initialUpdateState", () => {
  it("starts idle and carries the persisted auto-check flag", () => {
    expect(initialUpdateState(false)).toEqual({ status: "idle", autoCheckEnabled: false });
    expect(initialUpdateState(true).autoCheckEnabled).toBe(true);
  });
});

describe("updateReducer", () => {
  it("checkStarted → checking and clears any prior error", () => {
    const s = updateReducer(at("error", { error: "boom" }), { type: "checkStarted" });
    expect(s.status).toBe("checking");
    expect(s.error).toBeUndefined();
  });

  it("foundUpToDate → up-to-date, no updateInfo", () => {
    const s = updateReducer(at("checking"), { type: "foundUpToDate" });
    expect(s.status).toBe("up-to-date");
    expect(s.updateInfo).toBeUndefined();
  });

  it("foundAvailable → available with the update info", () => {
    const s = updateReducer(at("checking"), { type: "foundAvailable", info: INFO });
    expect(s.status).toBe("available");
    expect(s.updateInfo).toEqual(INFO);
  });

  it("downloadStarted only fires from available and zeroes progress", () => {
    const started = updateReducer(at("available", { updateInfo: INFO }), { type: "downloadStarted" });
    expect(started.status).toBe("downloading");
    expect(started.progress).toEqual({ downloaded: 0 });
    // Ignored from a non-available state (guards a double trigger).
    expect(updateReducer(at("ready"), { type: "downloadStarted" }).status).toBe("ready");
  });

  it("downloadProgress updates only while downloading", () => {
    const dl = at("downloading", { updateInfo: INFO, progress: { downloaded: 0 } });
    const p = updateReducer(dl, { type: "downloadProgress", progress: { downloaded: 50, total: 100 } });
    expect(p.progress).toEqual({ downloaded: 50, total: 100 });
    // A stray progress tick after ready is ignored.
    expect(updateReducer(at("ready"), { type: "downloadProgress", progress: { downloaded: 9 } }).status).toBe(
      "ready",
    );
  });

  it("downloadReady → ready only from downloading", () => {
    expect(updateReducer(at("downloading", { updateInfo: INFO }), { type: "downloadReady" }).status).toBe(
      "ready",
    );
    expect(updateReducer(at("available"), { type: "downloadReady" }).status).toBe("available");
  });

  it("failed → error from any in-flight state and drops progress", () => {
    const s = updateReducer(at("downloading", { progress: { downloaded: 5 } }), {
      type: "failed",
      error: "network down",
    });
    expect(s.status).toBe("error");
    expect(s.error).toBe("network down");
    expect(s.progress).toBeUndefined();
  });

  it("skip records the dismissed version and returns to idle", () => {
    const s = updateReducer(at("available", { updateInfo: INFO }), { type: "skip", version: "0.0.2" });
    expect(s.status).toBe("idle");
    expect(s.dismissedVersion).toBe("0.0.2");
    expect(s.updateInfo).toBeUndefined();
  });

  it("setAutoCheck flips the flag without touching status", () => {
    const s = updateReducer(at("available", { updateInfo: INFO }), { type: "setAutoCheck", enabled: false });
    expect(s.autoCheckEnabled).toBe(false);
    expect(s.status).toBe("available");
  });

  it("reset returns to idle but keeps the auto-check flag", () => {
    const s = updateReducer(at("error", { autoCheckEnabled: false, error: "x" }), { type: "reset" });
    expect(s).toEqual({ status: "idle", autoCheckEnabled: false });
  });
});

describe("isCardVisible", () => {
  it("shows for available/downloading/ready with an update", () => {
    for (const status of ["available", "downloading", "ready"] as const) {
      expect(isCardVisible(at(status, { updateInfo: INFO }))).toBe(true);
    }
  });

  it("hides without an update, when idle/up-to-date, or when this version was skipped", () => {
    expect(isCardVisible(at("available"))).toBe(false); // no updateInfo
    expect(isCardVisible(at("up-to-date", { updateInfo: INFO }))).toBe(false);
    expect(isCardVisible(at("available", { updateInfo: INFO, dismissedVersion: "0.0.2" }))).toBe(false);
  });
});

describe("progressPercent", () => {
  it("is 0 without a total and clamps to 100", () => {
    expect(progressPercent(undefined)).toBe(0);
    expect(progressPercent({ downloaded: 5 })).toBe(0);
    expect(progressPercent({ downloaded: 50, total: 100 })).toBe(50);
    expect(progressPercent({ downloaded: 200, total: 100 })).toBe(100);
  });
});
