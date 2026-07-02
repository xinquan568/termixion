// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the pure "should we check for updates now?" decision — the truth table behind the
// Automatic-updates master toggle and the Check-frequency setting (R8: failing tests first).
import { describe, expect, it } from "vitest";
import { shouldAutoCheck } from "./shouldAutoCheck";

const NOW = new Date("2026-07-02T12:00:00Z");
const HOURS = 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

describe("shouldAutoCheck", () => {
  it("never checks when the master toggle is off, regardless of frequency", () => {
    for (const frequency of ["on-startup", "daily", "weekly", "manual"] as const) {
      expect(shouldAutoCheck(NOW, { autoCheck: false, frequency, lastCheckAt: null })).toBe(false);
    }
  });

  it("never checks on manual-only", () => {
    expect(
      shouldAutoCheck(NOW, { autoCheck: true, frequency: "manual", lastCheckAt: null }),
    ).toBe(false);
    expect(
      shouldAutoCheck(NOW, { autoCheck: true, frequency: "manual", lastCheckAt: iso(999 * HOURS) }),
    ).toBe(false);
  });

  it("on-startup checks at every launch", () => {
    expect(
      shouldAutoCheck(NOW, { autoCheck: true, frequency: "on-startup", lastCheckAt: null }),
    ).toBe(true);
    expect(
      shouldAutoCheck(NOW, { autoCheck: true, frequency: "on-startup", lastCheckAt: iso(1) }),
    ).toBe(true);
  });

  it("daily checks when the last check is 24h+ old or unknown", () => {
    expect(shouldAutoCheck(NOW, { autoCheck: true, frequency: "daily", lastCheckAt: null })).toBe(true);
    expect(
      shouldAutoCheck(NOW, { autoCheck: true, frequency: "daily", lastCheckAt: iso(25 * HOURS) }),
    ).toBe(true);
    expect(
      shouldAutoCheck(NOW, { autoCheck: true, frequency: "daily", lastCheckAt: iso(2 * HOURS) }),
    ).toBe(false);
  });

  it("weekly checks when the last check is 7d+ old or unknown", () => {
    expect(shouldAutoCheck(NOW, { autoCheck: true, frequency: "weekly", lastCheckAt: null })).toBe(true);
    expect(
      shouldAutoCheck(NOW, { autoCheck: true, frequency: "weekly", lastCheckAt: iso(8 * 24 * HOURS) }),
    ).toBe(true);
    expect(
      shouldAutoCheck(NOW, { autoCheck: true, frequency: "weekly", lastCheckAt: iso(2 * 24 * HOURS) }),
    ).toBe(false);
  });

  it("treats an unparseable lastCheckAt as never-checked (checks), and never throws", () => {
    expect(
      shouldAutoCheck(NOW, { autoCheck: true, frequency: "daily", lastCheckAt: "not-a-date" }),
    ).toBe(true);
    expect(
      shouldAutoCheck(NOW, { autoCheck: true, frequency: "weekly", lastCheckAt: "" }),
    ).toBe(true);
  });

  it("a future lastCheckAt (clock skew) suppresses the periodic check rather than crashing", () => {
    expect(
      shouldAutoCheck(NOW, { autoCheck: true, frequency: "daily", lastCheckAt: iso(-2 * HOURS) }),
    ).toBe(false);
  });
});
