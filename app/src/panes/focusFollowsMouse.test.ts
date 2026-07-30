// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
// trmx-225: the pure FFM decision matrix — every no-action outcome observable directly.

import { describe, expect, it } from "vitest";

import { shouldFocusOnHover } from "./focusFollowsMouse";

describe("shouldFocusOnHover (trmx-225)", () => {
  it("focuses only when enabled, actually moved, over a non-focused pane, unsuspended", () => {
    expect(shouldFocusOnHover(true, true, false, false)).toBe(true);
  });

  it("the setting gates everything (opt-in, default off)", () => {
    expect(shouldFocusOnHover(false, true, false, false)).toBe(false);
  });

  it("a stationary pointer never refocuses (reflow-under-cursor)", () => {
    expect(shouldFocusOnHover(true, false, false, false)).toBe(false);
  });

  it("the already-focused pane is a no-op", () => {
    expect(shouldFocusOnHover(true, true, true, false)).toBe(false);
  });

  it("suspension wins over everything", () => {
    expect(shouldFocusOnHover(true, true, false, true)).toBe(false);
  });

  it("full falsy matrix: any single blocker suppresses the focus", () => {
    for (const enabled of [true, false])
      for (const moved of [true, false])
        for (const targetIsFocused of [true, false])
          for (const suspended of [true, false]) {
            const want = enabled && moved && !targetIsFocused && !suspended;
            expect(shouldFocusOnHover(enabled, moved, targetIsFocused, suspended)).toBe(want);
          }
  });
});
