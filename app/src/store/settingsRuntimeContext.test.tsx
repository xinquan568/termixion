// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-253 (T3.3) — the seam that lets a BOOT-LOCAL runtime reach the React tree.
//
// boot.test.tsx executes the wiring (trmx-250; one construction, before hydration, one
// provider above both surfaces); this pins the mechanism's behaviour: what a consumer under a
// provider gets, what one without a provider gets, and that a store built through the hook does not
// churn on re-render (both hosts hold theirs across the lifetime of the window).
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  SettingsRuntimeProvider,
  useSettingsRuntime,
  useSettingsStore,
} from "./settingsRuntimeContext";
import { createSettingsRuntime } from "./settingsStore";

function CursorStyleProbe() {
  return <span data-testid="value">{useSettingsStore().get("terminal.cursorStyle")}</span>;
}

describe("trmx-253 (T3.3): the settings runtime context", () => {
  it("hands consumers the PROVIDED runtime, and each provider its own", () => {
    const runtime = createSettingsRuntime();
    runtime.makeStore().set("terminal.cursorStyle", "block");
    render(
      <SettingsRuntimeProvider runtime={runtime}>
        <CursorStyleProbe />
      </SettingsRuntimeProvider>,
    );
    expect(screen.getByTestId("value").textContent).toBe("block");
    // A DIFFERENT runtime never saw that write — which is the whole point: the boot runtime is an
    // object, not a global, and a consumer reads the one that was handed to it.
    expect(createSettingsRuntime().makeStore().get("terminal.cursorStyle")).not.toBe("block");
  });

  it("THROWS with no provider above it (trmx-253 T3.5: no ambient fallback any more)", () => {
    function Probe() {
      useSettingsRuntime();
      return null;
    }
    // The failure mode this replaces is the dangerous one: a lazily created ambient runtime would
    // be a SECOND runtime that nothing hydrated, so a component outside the provider would read
    // registry defaults instead of the user's config file — silently. A throw at mount is loud.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<Probe />)).toThrow(/SettingsRuntimeProvider/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps one store per runtime across re-renders", () => {
    const runtime = createSettingsRuntime();
    const stores: unknown[] = [];
    let bump: () => void = () => {};
    function Probe() {
      const [, setTick] = useState(0);
      bump = () => setTick((t) => t + 1);
      stores.push(useSettingsStore());
      return null;
    }
    render(
      <SettingsRuntimeProvider runtime={runtime}>
        <Probe />
      </SettingsRuntimeProvider>,
    );
    act(() => bump());
    expect(stores.length).toBeGreaterThan(1);
    expect(new Set(stores).size).toBe(1);
  });
});
