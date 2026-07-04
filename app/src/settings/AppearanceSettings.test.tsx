// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53 (test-first): the Appearance page — the Theme row of six labeled swatches (vmark's
// Appearance page, per issues/trmx-53/theme-*.png). A radiogroup CONTROLLED by the shell: the
// selected swatch comes from the `selected` prop (SettingsApp's theme state), so cross-window
// broadcasts and About-page resets move the ring too; clicking persists through the registry and
// notifies the shell so the window restyles immediately even without a bus (plain dev).
// trmx-81 (FR-2.2, test-first): the "Tab bar" group below Theme — a Position row whose
// SegmentedControl binds tabs.barPosition (write through settings.set — the store broadcasts,
// App applies).
// trmx-82 (FR-2.3, test-first): the Position row is now CONTROLLED by the shell too (the D5
// lift: `barPosition` prop + onBarPositionChange, the exact theme pattern) so the page reflects
// external moves live, and the new Orientation row (tabs.sideLabelOrientation) below it is
// gated PURELY by that prop — disabled with a hint on top/bottom bars, never writing while
// disabled.
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

const ORIENTATION_HINT = "Only applies when the tab bar is on the left or right.";

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
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
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
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="sepia"
        barPosition="bottom"
      />,
    );
    const sepia = screen.getByRole("radio", { name: "Sepia" });
    expect(sepia).toHaveAttribute("aria-checked", "true");
    expect(sepia.className).toContain("tx-swatch--active");
    expect(screen.getByRole("radio", { name: "White" })).toHaveAttribute("aria-checked", "false");

    // The shell moving the selection (e.g. a cross-window broadcast) moves the ring.
    rerender(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="mint"
        barPosition="bottom"
      />,
    );
    expect(screen.getByRole("radio", { name: "Mint" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Sepia" })).toHaveAttribute("aria-checked", "false");
  });

  it("fills each swatch circle with that theme's background color", () => {
    render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
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
      <AppearanceSettings
        settings={settings}
        selected="night"
        onThemeChange={onThemeChange}
        barPosition="bottom"
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Mint" }));

    expect(storage.data.get("termixion.appearance.theme")).toBe("mint");
    expect(onThemeChange).toHaveBeenCalledWith("mint");
  });
});

describe("AppearanceSettings — Tab bar (trmx-81, FR-2.2)", () => {
  it("renders the Tab bar group BELOW Theme with the four Position segments", () => {
    const { container } = render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
    );
    // Group order on the page: Theme first, Tab bar second.
    const titles = [...container.querySelectorAll(".tx-settings-group__title")].map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["Theme", "Tab bar"]);

    const group = screen.getByRole("radiogroup", { name: "Tab bar position" });
    const segments = within(group).getAllByRole("radio");
    expect(segments.map((s) => s.textContent)).toEqual(["Top", "Bottom", "Left", "Right"]);
    // The barPosition prop's segment is the selected one.
    expect(within(group).getByRole("radio", { name: "Bottom" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(group).getByRole("radio", { name: "Top" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("reflects the barPosition PROP — controlled by the shell (trmx-82 D5 lift)", () => {
    const settings = makeSettingsStore(fakeStorage());
    const { rerender } = render(
      <AppearanceSettings settings={settings} selected="night" barPosition="left" />,
    );
    expect(screen.getByRole("radio", { name: "Left" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Bottom" })).toHaveAttribute("aria-checked", "false");

    // The shell moving the position (an external settings:changed) moves the selection too.
    rerender(<AppearanceSettings settings={settings} selected="night" barPosition="top" />);
    expect(screen.getByRole("radio", { name: "Top" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Left" })).toHaveAttribute("aria-checked", "false");
  });

  it("clicking a segment writes through settings.set (persist + broadcast) and notifies the shell", () => {
    const storage = fakeStorage();
    const bus = fakeBus();
    const settings = makeSettingsStore(storage, bus, "settings-window");
    const onBarPositionChange = vi.fn();
    const { rerender } = render(
      <AppearanceSettings
        settings={settings}
        selected="night"
        barPosition="bottom"
        onBarPositionChange={onBarPositionChange}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Top" }));

    // Persisted through the registry…
    expect(storage.data.get("termixion.tabs.barPosition")).toBe("top");
    // …broadcast for the main window's live application (the store owns the emit)…
    expect(bus.events).toContainEqual({
      event: SETTINGS_CHANGED_EVENT,
      payload: { key: "tabs.barPosition", value: "top", source: "settings-window" },
    });
    // …and the shell was notified (the busless dev path — it feeds the prop back).
    expect(onBarPositionChange).toHaveBeenCalledWith("top");
    rerender(
      <AppearanceSettings
        settings={settings}
        selected="night"
        barPosition="top"
        onBarPositionChange={onBarPositionChange}
      />,
    );
    expect(screen.getByRole("radio", { name: "Top" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Bottom" })).toHaveAttribute("aria-checked", "false");
  });

  it("re-clicking the selected segment writes nothing (the SegmentedControl no-op contract)", () => {
    const storage = fakeStorage();
    const bus = fakeBus();
    const settings = makeSettingsStore(storage, bus, "settings-window");
    const onBarPositionChange = vi.fn();
    render(
      <AppearanceSettings
        settings={settings}
        selected="night"
        barPosition="bottom"
        onBarPositionChange={onBarPositionChange}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Bottom" }));

    expect(storage.data.has("termixion.tabs.barPosition")).toBe(false);
    expect(bus.events).toEqual([]);
    expect(onBarPositionChange).not.toHaveBeenCalled();
  });
});

describe("AppearanceSettings — Orientation (trmx-82, FR-2.3)", () => {
  it("renders the Orientation row below Position, enabled on a LEFT bar, Horizontal by default", () => {
    const { container } = render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="left"
      />,
    );
    // Row order inside the Tab bar group: Position first, Orientation second.
    const labels = [...container.querySelectorAll(".tx-setting-row__label")].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Position", "Orientation"]);

    const group = screen.getByRole("radiogroup", { name: "Tab label orientation" });
    const segments = within(group).getAllByRole("radio");
    expect(segments.map((s) => s.textContent)).toEqual(["Horizontal", "Vertical"]);
    // The registry default (tabs.sideLabelOrientation = horizontal) is the selected segment.
    expect(within(group).getByRole("radio", { name: "Horizontal" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Enabled on a side bar: no aria-disabled, no hint.
    expect(group).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText(ORIENTATION_HINT)).not.toBeInTheDocument();
  });

  it("is enabled on a RIGHT bar and reads the persisted orientation from the injected store", () => {
    const storage = fakeStorage({ "termixion.tabs.sideLabelOrientation": "vertical" });
    render(
      <AppearanceSettings
        settings={makeSettingsStore(storage)}
        selected="night"
        barPosition="right"
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Tab label orientation" });
    expect(group).not.toHaveAttribute("aria-disabled");
    expect(within(group).getByRole("radio", { name: "Vertical" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it.each(["top", "bottom"] as const)(
    "is disabled with the hint line when the bar sits on the %s edge",
    (position) => {
      render(
        <AppearanceSettings
          settings={makeSettingsStore(fakeStorage())}
          selected="night"
          barPosition={position}
        />,
      );
      const group = screen.getByRole("radiogroup", { name: "Tab label orientation" });
      expect(group).toHaveAttribute("aria-disabled", "true");
      for (const radio of within(group).getAllByRole("radio")) {
        expect(radio).toHaveAttribute("aria-disabled", "true");
      }
      expect(screen.getByText(ORIENTATION_HINT)).toBeInTheDocument();
    },
  );

  it("flips live when the barPosition prop changes (derived purely — no own subscription)", () => {
    const settings = makeSettingsStore(fakeStorage());
    const { rerender } = render(
      <AppearanceSettings settings={settings} selected="night" barPosition="bottom" />,
    );
    const group = () => screen.getByRole("radiogroup", { name: "Tab label orientation" });
    expect(group()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(ORIENTATION_HINT)).toBeInTheDocument();

    rerender(<AppearanceSettings settings={settings} selected="night" barPosition="left" />);
    expect(group()).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText(ORIENTATION_HINT)).not.toBeInTheDocument();

    rerender(<AppearanceSettings settings={settings} selected="night" barPosition="top" />);
    expect(group()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(ORIENTATION_HINT)).toBeInTheDocument();
  });

  it("writes through settings.set (persist + broadcast) when enabled", () => {
    const storage = fakeStorage();
    const bus = fakeBus();
    const settings = makeSettingsStore(storage, bus, "settings-window");
    render(<AppearanceSettings settings={settings} selected="night" barPosition="left" />);

    fireEvent.click(screen.getByRole("radio", { name: "Vertical" }));

    expect(storage.data.get("termixion.tabs.sideLabelOrientation")).toBe("vertical");
    expect(bus.events).toContainEqual({
      event: SETTINGS_CHANGED_EVENT,
      payload: { key: "tabs.sideLabelOrientation", value: "vertical", source: "settings-window" },
    });
    expect(screen.getByRole("radio", { name: "Vertical" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("never writes while disabled: store.set is not called and the persisted value is untouched", () => {
    const storage = fakeStorage({ "termixion.tabs.sideLabelOrientation": "horizontal" });
    const bus = fakeBus();
    const settings = makeSettingsStore(storage, bus, "settings-window");
    const setSpy = vi.spyOn(settings, "set");
    render(<AppearanceSettings settings={settings} selected="night" barPosition="bottom" />);

    const group = screen.getByRole("radiogroup", { name: "Tab label orientation" });
    fireEvent.click(within(group).getByRole("radio", { name: "Vertical" }));
    fireEvent.keyDown(within(group).getByRole("radio", { name: "Horizontal" }), {
      key: "ArrowRight",
    });

    expect(setSpy).not.toHaveBeenCalled();
    expect(storage.data.get("termixion.tabs.sideLabelOrientation")).toBe("horizontal");
    expect(bus.events).toEqual([]);
    expect(within(group).getByRole("radio", { name: "Horizontal" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
