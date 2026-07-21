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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";
import {
  makeSettingsStore,
  SETTINGS_CHANGED_EVENT,
  type KeyValueStore,
  type SettingsBus,
} from "./settingsStore";
import { themes } from "../theme/themes";
import { clearUserThemes, registerUserThemes, type UserThemeEntry } from "../theme/registry";
import type { ThemeSpec } from "../theme/themeDerive";
import type { AnsiPalette } from "../theme/tokens";
import type { InvokeFn } from "../ipc/backend";

const ORIENTATION_HINT = "Only applies when the tab bar is on the left or right.";

// --- trmx-89 (4b) user-theme fixtures (mirror registry.test.ts's spec/entry helpers) ---
const ANSI: AnsiPalette = {
  black: "#000000", red: "#ff0000", green: "#00ff00", yellow: "#ffff00",
  blue: "#0000ff", magenta: "#ff00ff", cyan: "#00ffff", white: "#ffffff",
  brightBlack: "#808080", brightRed: "#ff8080", brightGreen: "#80ff80", brightYellow: "#ffff80",
  brightBlue: "#8080ff", brightMagenta: "#ff80ff", brightCyan: "#80ffff", brightWhite: "#f0f6fc",
};

function spec(isDark: boolean, bgPrimary: string, textPrimary: string): ThemeSpec {
  return {
    isDark,
    color: { bg: { primary: bgPrimary }, text: { primary: textPrimary }, accent: {}, semantic: {} },
    terminal: { ansi: { ...ANSI }, scrollbar: {}, pane: {} },
  };
}

/** A valid, high-contrast user theme (black bg / white text → ~21:1, no contrast warning). */
function validUserEntry(id: string): UserThemeEntry {
  return { id, source: "user", valid: true, spec: spec(true, "#000000", "#ffffff"), warnings: [] };
}

/** A valid but LOW-CONTRAST user theme — derives fine, so it applies, but flags a warning. */
function lowContrastUserEntry(id: string): UserThemeEntry {
  return { id, source: "user", valid: true, spec: spec(false, "#8a8a8a", "#808080"), warnings: [] };
}

/** An INVALID user theme (unparseable) — listed for diagnosis, never applyable. */
function invalidUserEntry(id: string, message: string): UserThemeEntry {
  return {
    id,
    source: "user",
    valid: false,
    spec: null,
    warnings: [{ type: "InvalidColor", message }],
  };
}

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

// trmx-171: duplicate a built-in via the right-click context menu (replaces the removed per-swatch
// "Duplicate" button): right-click the swatch, then choose the menu's Duplicate item.
function duplicateViaMenu(themeLabel: string) {
  fireEvent.contextMenu(screen.getByRole("radio", { name: themeLabel }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Duplicate/ }));
}

describe("AppearanceSettings", () => {
  it("renders the Theme group with the eight labeled swatches, lightest to darkest (trmx-202)", () => {
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
      "Catppuccin Latte",
      "Nord",
      "Dracula",
      "Gruvbox",
      "Solarized",
      "Catppuccin Mocha",
      "Tokyo Night",
      "Night",
    ]);
  });

  it("marks the SELECTED prop's swatch (aria-checked + ring class) — controlled by the shell", () => {
    const { rerender } = render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="solarized"
        barPosition="bottom"
      />,
    );
    const solarized = screen.getByRole("radio", { name: "Solarized" });
    expect(solarized).toHaveAttribute("aria-checked", "true");
    expect(solarized.className).toContain("tx-swatch--active");
    expect(screen.getByRole("radio", { name: "Night" })).toHaveAttribute("aria-checked", "false");

    // The shell moving the selection (e.g. a cross-window broadcast) moves the ring.
    rerender(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="gruvbox"
        barPosition="bottom"
      />,
    );
    expect(screen.getByRole("radio", { name: "Gruvbox" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Solarized" })).toHaveAttribute("aria-checked", "false");
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

    fireEvent.click(screen.getByRole("radio", { name: "Gruvbox" }));

    expect(storage.data.get("termixion.appearance.theme")).toBe("gruvbox");
    expect(onThemeChange).toHaveBeenCalledWith("gruvbox");
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
    // Row order inside the Tab bar group: Position, Orientation, then Shortcut hints (trmx-151).
    const labels = [...container.querySelectorAll(".tx-setting-row__label")].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Position", "Orientation", "Shortcut hints"]);

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

// trmx-151 (test-first): the "Shortcut hints" toggle — tabs.showShortcutHints in the Tab bar
// group, wired exactly like the TerminalSettings boolean rows (read via settings.get at mount,
// write via settings.set → the store broadcasts and the main window's App strips the ⌘N prefixes
// live). Always enabled: hints render on every bar position, so no barPosition gate here.
describe("AppearanceSettings — Shortcut hints (trmx-151)", () => {
  const toggle = () => screen.getByRole("switch", { name: "Shortcut hints" });

  it("renders the row in the Tab bar group with its description, ON by default", () => {
    render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
    );
    expect(toggle()).toHaveAttribute("aria-checked", "true"); // registry default: on
    expect(
      screen.getByText("Show ⌘1–⌘9 before the first nine tab titles"),
    ).toBeInTheDocument();
  });

  it("reflects a persisted OFF from the injected store", () => {
    render(
      <AppearanceSettings
        settings={makeSettingsStore(
          fakeStorage({ "termixion.tabs.showShortcutHints": "false" }),
        )}
        selected="night"
        barPosition="bottom"
      />,
    );
    expect(toggle()).toHaveAttribute("aria-checked", "false");
  });

  it("a toggle writes through settings.set (persist + broadcast) and flips the switch", () => {
    const storage = fakeStorage();
    const bus = fakeBus();
    const settings = makeSettingsStore(storage, bus, "settings-window");
    render(<AppearanceSettings settings={settings} selected="night" barPosition="bottom" />);

    fireEvent.click(toggle());

    expect(storage.data.get("termixion.tabs.showShortcutHints")).toBe("false");
    expect(bus.events).toContainEqual({
      event: SETTINGS_CHANGED_EVENT,
      payload: { key: "tabs.showShortcutHints", value: false, source: "settings-window" },
    });
    expect(toggle()).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle()); // …and back on
    expect(storage.data.get("termixion.tabs.showShortcutHints")).toBe("true");
    expect(toggle()).toHaveAttribute("aria-checked", "true");
  });
});

// trmx-89 (4b, test-first): the USER-THEME picker. The Theme row lists the whole registry —
// built-ins THEN the hydrated user themes — with valid/invalid/warning affordances, a Duplicate
// on each built-in, an "Open themes folder" button, and the docs hint. The registry is
// module-level, so each test seeds/clears it in isolation.
describe("AppearanceSettings — user themes (trmx-89, 4b)", () => {
  beforeEach(() => clearUserThemes());
  afterEach(() => clearUserThemes());

  const themeGroup = () => screen.getByRole("radiogroup", { name: "Theme" });

  it("lists user themes AFTER the built-ins, labeled", () => {
    registerUserThemes([validUserEntry("user:cool"), validUserEntry("user:zed")]);
    render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
    );
    // The eight built-ins first (luminance order), then the two user themes (registry insertion order).
    expect(within(themeGroup()).getAllByRole("radio").map((s) => s.textContent)).toEqual([
      "Catppuccin Latte",
      "Nord",
      "Dracula",
      "Gruvbox",
      "Solarized",
      "Catppuccin Mocha",
      "Tokyo Night",
      "Night",
      "Cool",
      "Zed",
    ]);
  });

  it("fills a user swatch with its resolved background color and selects it exactly like a built-in", () => {
    registerUserThemes([validUserEntry("user:cool")]);
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
    const cool = screen.getByRole("radio", { name: "Cool" });
    // Black bg from the spec (jsdom normalizes hex → rgb; compare via a scratch element).
    const circle = cool.querySelector(".tx-swatch__circle") as HTMLElement;
    const probe = document.createElement("div");
    probe.style.background = "#000000";
    expect(circle.style.background).toBe(probe.style.background);

    fireEvent.click(cool);
    expect(storage.data.get("termixion.appearance.theme")).toBe("user:cool");
    expect(onThemeChange).toHaveBeenCalledWith("user:cool");
  });

  it("an INVALID user theme shows an 'invalid' badge + tooltip and is NOT selectable", () => {
    registerUserThemes([invalidUserEntry("user:bad", "invalid color at color.bg.primary")]);
    const settings = makeSettingsStore(fakeStorage());
    const setSpy = vi.spyOn(settings, "set");
    const onThemeChange = vi.fn();
    render(
      <AppearanceSettings
        settings={settings}
        selected="night"
        onThemeChange={onThemeChange}
        barPosition="bottom"
      />,
    );

    // The badge is shown, and the swatch is NOT a radio (it never joins the selectable set).
    expect(screen.getByText("invalid")).toBeInTheDocument();
    expect(within(themeGroup()).queryByRole("radio", { name: "Bad" })).toBeNull();

    // The swatch carries aria-disabled + the first diagnostic as a tooltip.
    const swatch = screen.getByText("Bad").closest(".tx-swatch") as HTMLElement;
    expect(swatch).toHaveAttribute("aria-disabled", "true");
    expect(swatch).toHaveAttribute("title", "invalid color at color.bg.primary");

    // Clicking the inert swatch (or its badge) never persists or notifies.
    fireEvent.click(swatch);
    fireEvent.click(screen.getByText("invalid"));
    expect(setSpy).not.toHaveBeenCalled();
    expect(onThemeChange).not.toHaveBeenCalled();
  });

  it("a low-contrast user theme is SELECTABLE and shows a 'warning' badge + tooltip", () => {
    registerUserThemes([lowContrastUserEntry("user:dim")]);
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

    expect(screen.getByText("warning")).toBeInTheDocument();
    const dim = screen.getByRole("radio", { name: "Dim" });
    expect(dim.getAttribute("title")).toContain("low contrast");

    // Still selectable — warnings never block.
    fireEvent.click(dim);
    expect(storage.data.get("termixion.appearance.theme")).toBe("user:dim");
    expect(onThemeChange).toHaveBeenCalledWith("user:dim");
  });

  it("'Open themes folder' calls the backend with themes_open_dir", async () => {
    const invoke = vi.fn<InvokeFn>().mockResolvedValue(undefined);
    render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
        invoke={invoke}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open themes folder" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("themes_open_dir"));
  });

  it("'Duplicate' (via the context menu) on a built-in writes a TOML copy, re-hydrates, and selects the new user id", async () => {
    const storage = fakeStorage();
    const settings = makeSettingsStore(storage);
    const onThemeChange = vi.fn();
    // themes_read returns [] (the file watcher will re-read for real); themes_write resolves the id.
    const invoke = vi
      .fn<InvokeFn>()
      .mockImplementation((cmd) =>
        Promise.resolve(cmd === "themes_read" ? [] : "user:night-copy"),
      );
    render(
      <AppearanceSettings
        settings={settings}
        selected="night"
        onThemeChange={onThemeChange}
        barPosition="bottom"
        invoke={invoke}
      />,
    );

    duplicateViaMenu("Night");

    // themes_write with a sane stem + a real TOML body …
    await waitFor(() =>
      expect(invoke.mock.calls.some((c) => c[0] === "themes_write")).toBe(true),
    );
    const writeCall = invoke.mock.calls.find((c) => c[0] === "themes_write")!;
    const args = writeCall[1] as { stem: string; text: string };
    expect(args.stem).toBe("night-copy");
    expect(args.text).toContain("is_dark");
    expect(args.text).toContain("[terminal.ansi]");
    expect(args.text).toContain("duplicated from Night");

    // … then a re-hydrate (themes_read) and the selection of the new user id.
    expect(invoke).toHaveBeenCalledWith("themes_read");
    await waitFor(() => expect(onThemeChange).toHaveBeenCalledWith("user:night-copy"));
    expect(storage.data.get("termixion.appearance.theme")).toBe("user:night-copy");
  });

  it("'Duplicate' auto-increments the stem past an existing user:<stem> copy", async () => {
    registerUserThemes([validUserEntry("user:night-copy")]);
    const invoke = vi
      .fn<InvokeFn>()
      .mockImplementation((cmd) => Promise.resolve(cmd === "themes_read" ? [] : "user:x"));
    render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
        invoke={invoke}
      />,
    );

    duplicateViaMenu("Night");

    await waitFor(() =>
      expect(invoke.mock.calls.some((c) => c[0] === "themes_write")).toBe(true),
    );
    const writeCall = invoke.mock.calls.find((c) => c[0] === "themes_write")!;
    expect((writeCall[1] as { stem: string }).stem).toBe("night-copy-2");
  });

  it("surfaces nothing fatal when the Duplicate write rejects", async () => {
    const settings = makeSettingsStore(fakeStorage());
    const setSpy = vi.spyOn(settings, "set");
    const onThemeChange = vi.fn();
    const invoke = vi
      .fn<InvokeFn>()
      .mockImplementation((cmd) =>
        cmd === "themes_write"
          ? Promise.reject(new Error("disk full"))
          : Promise.resolve([]),
      );
    render(
      <AppearanceSettings
        settings={settings}
        selected="night"
        onThemeChange={onThemeChange}
        barPosition="bottom"
        invoke={invoke}
      />,
    );

    duplicateViaMenu("Night");

    await waitFor(() =>
      expect(invoke.mock.calls.some((c) => c[0] === "themes_write")).toBe(true),
    );
    // A rejected write leaves the selection untouched (no theme set, no notify).
    expect(setSpy).not.toHaveBeenCalled();
    expect(onThemeChange).not.toHaveBeenCalled();
  });

  // trmx-171: Duplicate moved from a per-swatch button to a right-click context menu.
  it("renders NO 'Duplicate' button — the action moved to the right-click context menu", () => {
    const { container } = render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
    );
    expect(screen.queryByRole("button", { name: /^Duplicate/ })).toBeNull();
    expect(container.querySelector(".tx-swatch__dup")).toBeNull();
    // …and no menu is open until a right-click.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("right-clicking a BUILT-IN swatch opens the menu AND prevents the browser default menu", () => {
    render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
    );
    // fireEvent returns false when preventDefault() was called (the browser menu is suppressed).
    const notCancelled = fireEvent.contextMenu(screen.getByRole("radio", { name: "Night" }));
    expect(notCancelled).toBe(false);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Duplicate Night" })).toBeInTheDocument();
  });

  it("right-clicking a USER swatch opens NO menu and does NOT prevent the browser default", () => {
    registerUserThemes([validUserEntry("user:cool")]);
    render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
    );
    const notCancelled = fireEvent.contextMenu(screen.getByRole("radio", { name: "Cool" }));
    expect(notCancelled).toBe(true); // default NOT prevented — built-ins only
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("right-clicking an INVALID swatch opens NO menu and does NOT prevent the browser default", () => {
    registerUserThemes([invalidUserEntry("user:bad", "invalid color at color.bg.primary")]);
    const { container } = render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
    );
    // The invalid swatch is an inert div (not a radio, no onContextMenu) — right-click does nothing.
    const invalidSwatch = container.querySelector(".tx-swatch--invalid")!;
    const notCancelled = fireEvent.contextMenu(invalidSwatch);
    expect(notCancelled).toBe(true); // default NOT prevented
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens only ONE menu at a time (right-clicking a second built-in replaces the first)", () => {
    render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
    );
    fireEvent.contextMenu(screen.getByRole("radio", { name: "Night" }));
    fireEvent.contextMenu(screen.getByRole("radio", { name: "Solarized" }));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "Duplicate Solarized" })).toBeInTheDocument();
  });

  it("shows the right-click duplicate tip", () => {
    render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
    );
    expect(
      screen.getByText("Right-click a theme to duplicate it, or create a brand-new one."),
    ).toBeInTheDocument();
  });

  it("shows the theme-file-format docs hint", () => {
    render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
    );
    expect(screen.getByText(/Learn the theme file format/i)).toBeInTheDocument();
  });

  it("keeps the two group titles (no third group) with the picker additions inside Theme", () => {
    registerUserThemes([validUserEntry("user:cool"), invalidUserEntry("user:bad", "bad")]);
    const { container } = render(
      <AppearanceSettings
        settings={makeSettingsStore(fakeStorage())}
        selected="night"
        barPosition="bottom"
      />,
    );
    const titles = [...container.querySelectorAll(".tx-settings-group__title")].map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["Theme", "Tab bar"]);
  });
});
