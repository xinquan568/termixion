// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53 (test-first): the Appearance page — the Theme row of six labeled swatches (vmark's
// Appearance page, per issues/trmx-53/theme-*.png). A radiogroup CONTROLLED by the shell: the
// selected swatch comes from the `selected` prop (SettingsApp's theme state), so cross-window
// broadcasts and About-page resets move the ring too; clicking persists through the registry and
// notifies the shell so the window restyles immediately even without a bus (plain dev).
// trmx-81 (FR-2.2, test-first): the "Tab bar" group below Theme — a Position row whose
// SegmentedControl binds tabs.barPosition (read the injected store at mount, write through
// settings.set — the store broadcasts, App applies).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";
import {
  makeSettingsStore,
  SETTINGS_CHANGED_EVENT,
  type KeyValueStore,
  type SettingsBus,
} from "./settingsStore";
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

function fakeBus(): SettingsBus & { events: Array<{ event: string; payload: unknown }> } {
  const events: Array<{ event: string; payload: unknown }> = [];
  return { events, emit: (event, payload) => void events.push({ event, payload }) };
}

describe("AppearanceSettings", () => {
  it("renders the Theme group with the six labeled swatches in the issue's order", () => {
    render(
      <AppearanceSettings settings={makeSettingsStore(fakeStorage())} selected="night" />,
    );
    expect(screen.getByText("Theme")).toBeInTheDocument();
    // Scoped to the Theme radiogroup — trmx-81 adds the Position radiogroup below it.
    const swatches = within(screen.getByRole("radiogroup", { name: "Theme" })).getAllByRole(
      "radio",
    );
    expect(swatches.map((s) => s.textContent)).toEqual([
      "White",
      "Paper",
      "Mint",
      "Sepia",
      "Night",
      "Solarized",
    ]);
  });

  it("marks the SELECTED prop's swatch (aria-checked + ring class) — controlled by the shell", () => {
    const { rerender } = render(
      <AppearanceSettings settings={makeSettingsStore(fakeStorage())} selected="sepia" />,
    );
    const sepia = screen.getByRole("radio", { name: "Sepia" });
    expect(sepia).toHaveAttribute("aria-checked", "true");
    expect(sepia.className).toContain("tx-swatch--active");
    expect(screen.getByRole("radio", { name: "White" })).toHaveAttribute("aria-checked", "false");

    // The shell moving the selection (e.g. a cross-window broadcast) moves the ring.
    rerender(
      <AppearanceSettings settings={makeSettingsStore(fakeStorage())} selected="mint" />,
    );
    expect(screen.getByRole("radio", { name: "Mint" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Sepia" })).toHaveAttribute("aria-checked", "false");
  });

  it("fills each swatch circle with that theme's background color", () => {
    render(
      <AppearanceSettings settings={makeSettingsStore(fakeStorage())} selected="night" />,
    );
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
    render(
      <AppearanceSettings settings={settings} selected="night" onThemeChange={onThemeChange} />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Mint" }));

    expect(storage.data.get("termixion.appearance.theme")).toBe("mint");
    expect(onThemeChange).toHaveBeenCalledWith("mint");
  });
});

describe("AppearanceSettings — Tab bar (trmx-81, FR-2.2)", () => {
  it("renders the Tab bar group BELOW Theme with the four Position segments, Bottom by default", () => {
    const { container } = render(
      <AppearanceSettings settings={makeSettingsStore(fakeStorage())} selected="night" />,
    );
    // Group order on the page: Theme first, Tab bar second.
    const titles = [...container.querySelectorAll(".tx-settings-group__title")].map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["Theme", "Tab bar"]);

    const group = screen.getByRole("radiogroup", { name: "Tab bar position" });
    const segments = within(group).getAllByRole("radio");
    expect(segments.map((s) => s.textContent)).toEqual(["Top", "Bottom", "Left", "Right"]);
    // The registry default (tabs.barPosition = bottom) is the selected segment.
    expect(within(group).getByRole("radio", { name: "Bottom" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(group).getByRole("radio", { name: "Top" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("reads the CURRENT value from the injected store (a persisted 'left' selects Left)", () => {
    const storage = fakeStorage({ "termixion.tabs.barPosition": "left" });
    render(<AppearanceSettings settings={makeSettingsStore(storage)} selected="night" />);
    expect(screen.getByRole("radio", { name: "Left" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Bottom" })).toHaveAttribute("aria-checked", "false");
  });

  it("clicking a segment writes through settings.set (persist + broadcast) and moves aria-checked", () => {
    const storage = fakeStorage();
    const bus = fakeBus();
    const settings = makeSettingsStore(storage, bus, "settings-window");
    render(<AppearanceSettings settings={settings} selected="night" />);

    fireEvent.click(screen.getByRole("radio", { name: "Top" }));

    // Persisted through the registry…
    expect(storage.data.get("termixion.tabs.barPosition")).toBe("top");
    // …broadcast for the main window's live application (the store owns the emit)…
    expect(bus.events).toContainEqual({
      event: SETTINGS_CHANGED_EVENT,
      payload: { key: "tabs.barPosition", value: "top", source: "settings-window" },
    });
    // …and the control reflects the new selection.
    expect(screen.getByRole("radio", { name: "Top" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Bottom" })).toHaveAttribute("aria-checked", "false");
  });

  it("re-clicking the selected segment writes nothing (the SegmentedControl no-op contract)", () => {
    const storage = fakeStorage();
    const bus = fakeBus();
    const settings = makeSettingsStore(storage, bus, "settings-window");
    render(<AppearanceSettings settings={settings} selected="night" />);

    fireEvent.click(screen.getByRole("radio", { name: "Bottom" }));

    expect(storage.data.has("termixion.tabs.barPosition")).toBe(false);
    expect(bus.events).toEqual([]);
  });
});
