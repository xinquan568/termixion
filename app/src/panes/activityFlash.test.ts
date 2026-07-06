// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-99 (FR-7b, test-first): the exit-code flash policy.
import { describe, it, expect } from "vitest";
import { shouldFlash, FLASH_MS } from "./activityFlash";

describe("activityFlash — shouldFlash", () => {
  it("a non-zero exit flashes", () => {
    expect(shouldFlash(1)).toBe(true);
    expect(shouldFlash(130)).toBe(true);
  });
  it("a zero exit does NOT flash (success)", () => {
    expect(shouldFlash(0)).toBe(false);
  });
  it("an absent / non-numeric exit code does NOT flash (review finding 5)", () => {
    expect(shouldFlash(undefined)).toBe(false);
  });
  it("FLASH_MS is a positive duration", () => {
    expect(FLASH_MS).toBeGreaterThan(0);
  });
});
