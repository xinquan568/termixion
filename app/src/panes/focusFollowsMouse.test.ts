// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
// trmx-225: the pure FFM decision matrix — every no-action outcome observable directly.

import { describe, expect, it } from "vitest";

import { shouldFocusOnHover } from "./focusFollowsMouse";

describe("shouldFocusOnHover (trmx-225)", () => {
  const go = { enabled: true, moved: true, targetIsFocused: false, suspended: false };

  it("focuses only when enabled, actually moved, over a non-focused pane, unsuspended", () => {
    expect(shouldFocusOnHover(go)).toBe(true);
  });

  it("the setting gates everything (opt-in, default off)", () => {
    expect(shouldFocusOnHover({ ...go, enabled: false })).toBe(false);
  });

  it("a stationary pointer never refocuses (reflow-under-cursor)", () => {
    expect(shouldFocusOnHover({ ...go, moved: false })).toBe(false);
  });

  it("the already-focused pane is a no-op", () => {
    expect(shouldFocusOnHover({ ...go, targetIsFocused: true })).toBe(false);
  });

  it("suspension wins over everything", () => {
    expect(shouldFocusOnHover({ ...go, suspended: true })).toBe(false);
  });

  it("full falsy matrix: any single blocker suppresses the focus", () => {
    for (const enabled of [true, false])
      for (const moved of [true, false])
        for (const targetIsFocused of [true, false])
          for (const suspended of [true, false]) {
            const want = enabled && moved && !targetIsFocused && !suspended;
            expect(shouldFocusOnHover({ enabled, moved, targetIsFocused, suspended })).toBe(want);
          }
  });
});
