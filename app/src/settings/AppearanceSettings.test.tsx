// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53 (test-first): the Appearance page — the Theme row of six labeled swatches (vmark's
// Appearance page, per issues/trmx-53/theme-*.png). A radiogroup: the selected swatch is
// aria-checked and ring-highlighted; clicking persists through the registry and notifies the
// shell so the window restyles immediately even without a bus (plain dev).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";
import { makeSettingsStore, type KeyValueStore } from "./settingsStore";
import { themes } from "../theme/themes";

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("AppearanceSettings", () => {
  it("renders the Theme group with the six labeled swatches in the issue's order", () => {
    render(<AppearanceSettings settings={makeSettingsStore(fakeStorage())} />);
    expect(screen.getByText("Theme")).toBeInTheDocument();
    const swatches = screen.getAllByRole("radio");
    expect(swatches.map((s) => s.textContent)).toEqual([
      "White",
      "Paper",
      "Mint",
      "Sepia",
      "Night",
      "Solarized",
    ]);
  });

  it("marks the persisted theme's swatch as selected (aria-checked + ring class)", () => {
    const settings = makeSettingsStore(
      fakeStorage({ "termixion.appearance.theme": "sepia" }),
    );
    render(<AppearanceSettings settings={settings} />);
    const sepia = screen.getByRole("radio", { name: "Sepia" });
    expect(sepia).toHaveAttribute("aria-checked", "true");
    expect(sepia.className).toContain("tx-swatch--active");
    expect(screen.getByRole("radio", { name: "White" })).toHaveAttribute("aria-checked", "false");
  });

  it("fills each swatch circle with that theme's background color", () => {
    render(<AppearanceSettings settings={makeSettingsStore(fakeStorage())} />);
    const night = screen.getByRole("radio", { name: "Night" });
    const circle = night.querySelector(".tx-swatch__circle") as HTMLElement;
    // jsdom normalizes hex to rgb; compare via a scratch element.
    const probe = document.createElement("div");
    probe.style.background = themes.night.color.bg.primary;
    expect(circle.style.background).toBe(probe.style.background);
  });

  it("persists the choice and notifies the shell on click", () => {
    const storage = fakeStorage();
    const settings = makeSettingsStore(storage);
    const onThemeChange = vi.fn();
    render(<AppearanceSettings settings={settings} onThemeChange={onThemeChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "Mint" }));

    expect(storage.data.get("termixion.appearance.theme")).toBe("mint");
    expect(onThemeChange).toHaveBeenCalledWith("mint");
    expect(screen.getByRole("radio", { name: "Mint" })).toHaveAttribute("aria-checked", "true");
  });
});
