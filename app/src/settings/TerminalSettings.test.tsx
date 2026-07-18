// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the Terminal settings page spec — the two red-boxed rows from the vmark screenshot
// (Cursor Style + Cursor Blink), vmark's option labels with cursor glyphs, the registry defaults
// (Underline; blink off since trmx-55), persistence through the settings store, and the
// settings:changed broadcast the live terminal consumes. R8: written before the page exists.
// trmx-80 (FR-13) adds the scrollback/font trio below them: Scrollback (clamped numeric field),
// Font Family (empty = the platform default stack, named in the placeholder), Font Size (stepper).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalSettings } from "./TerminalSettings";
import { ITERM2_FONT_FAMILY } from "../terminal/iterm2Theme";
import {
  makeSettingsStore,
  SETTINGS_CHANGED_EVENT,
  type KeyValueStore,
  type SettingsBus,
} from "./settingsStore";

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function fakeBus(): SettingsBus & { events: Array<{ event: string; payload: unknown }> } {
  const events: Array<{ event: string; payload: unknown }> = [];
  return { events, emit: (event, payload) => void events.push({ event, payload }) };
}

describe("TerminalSettings", () => {
  it("renders the cursor rows plus the FR-13 trio — Scrollback, Font Family, Font Size", () => {
    const store = makeSettingsStore(fakeStorage());
    const { container } = render(<TerminalSettings settings={store} />);
    expect(screen.getByText("Cursor Style")).toBeInTheDocument();
    expect(screen.getByText("Shape of the terminal cursor")).toBeInTheDocument();
    expect(screen.getByText("Cursor Blink")).toBeInTheDocument();
    expect(screen.getByText("Whether the terminal cursor blinks")).toBeInTheDocument();
    // trmx-80: the scrollback/font trio, BELOW the two cursor rows.
    expect(screen.getByText("Scrollback")).toBeInTheDocument();
    expect(screen.getByText("Lines of history kept per terminal")).toBeInTheDocument();
    expect(screen.getByText("Font Family")).toBeInTheDocument();
    expect(screen.getByText("Font Size")).toBeInTheDocument();
    // trmx-95: the Copy on Select toggle sits below Cursor Blink; trmx-91's Activity Indicator follows.
    expect(screen.getByText("Copy on Select")).toBeInTheDocument();
    expect(
      screen.getByText("Automatically copy the mouse selection to the clipboard (iTerm2-style)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Activity Indicator")).toBeInTheDocument();
    expect(screen.getByText("Show a green line while a command is running")).toBeInTheDocument();
    // trmx-144: the close-confirmation tri-state sits below Activity Indicator.
    expect(screen.getByText("Confirm before closing")).toBeInTheDocument();
    expect(
      screen.getByText(
        'Applies when closing a pane, a tab, or quitting; "When busy" prompts only when a program is still running',
      ),
    ).toBeInTheDocument();
    // trmx-190: the AI Session Counter toggle sits directly below Activity Indicator (its peer).
    expect(screen.getByText("AI Session Counter")).toBeInTheDocument();
    expect(
      screen.getByText("Show live AI session counts in the title bar"),
    ).toBeInTheDocument();
    // EXACTLY these nine rows (no Shell / Panel / Line Height).
    const rows = container.querySelectorAll(".tx-setting-row");
    expect(rows).toHaveLength(9);
    const labels = [...rows].map((r) => r.querySelector(".tx-setting-row__label")?.textContent);
    expect(labels).toEqual([
      "Cursor Style",
      "Cursor Blink",
      "Copy on Select",
      "Activity Indicator",
      "AI Session Counter",
      "Confirm before closing",
      "Scrollback",
      "Font Family",
      "Font Size",
    ]);
  });

  it("offers vmark's glyphed options and defaults to Underline", () => {
    const store = makeSettingsStore(fakeStorage());
    render(<TerminalSettings settings={store} />);
    const select = screen.getByRole("combobox", { name: "Cursor Style" }) as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.label);
    expect(labels).toEqual(["Bar │", "Block █", "Underline ▁"]);
    expect(select.value).toBe("underline");
  });

  it("defaults Cursor Blink to off (trmx-55, iTerm2-default parity)", () => {
    const store = makeSettingsStore(fakeStorage());
    render(<TerminalSettings settings={store} />);
    expect(screen.getByRole("switch", { name: "Cursor Blink" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("defaults Activity Indicator to ON and persists a toggle (trmx-91)", () => {
    const store = makeSettingsStore(fakeStorage());
    render(<TerminalSettings settings={store} />);
    const toggle = screen.getByRole("switch", { name: "Activity Indicator" });
    expect(toggle).toHaveAttribute("aria-checked", "true"); // default on
    fireEvent.click(toggle);
    expect(store.get("terminal.activityIndicator")).toBe(false); // toggled off, persisted
  });

  it("defaults AI Session Counter to ON and persists a toggle (trmx-190)", () => {
    const store = makeSettingsStore(fakeStorage());
    render(<TerminalSettings settings={store} />);
    const toggle = screen.getByRole("switch", { name: "AI Session Counter" });
    expect(toggle).toHaveAttribute("aria-checked", "true"); // default on
    fireEvent.click(toggle);
    expect(store.get("titleBar.aiCounter")).toBe(false); // toggled off, persisted
  });

  it("defaults Copy on Select to ON and persists a toggle (trmx-95)", () => {
    const store = makeSettingsStore(fakeStorage());
    render(<TerminalSettings settings={store} />);
    const toggle = screen.getByRole("switch", { name: "Copy on Select" });
    expect(toggle).toHaveAttribute("aria-checked", "true"); // default on (iTerm2 parity)
    fireEvent.click(toggle);
    expect(store.get("terminal.copyOnSelect")).toBe(false); // toggled off, persisted
  });

  it("persists a cursor style change and broadcasts it for the live terminal", () => {
    const storage = fakeStorage();
    const bus = fakeBus();
    const store = makeSettingsStore(storage, bus, "settings-window");
    render(<TerminalSettings settings={store} />);
    const select = screen.getByRole("combobox", { name: "Cursor Style" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "bar" } });
    expect(select.value).toBe("bar");
    expect(store.get("terminal.cursorStyle")).toBe("bar");
    expect(bus.events).toContainEqual({
      event: SETTINGS_CHANGED_EVENT,
      payload: { key: "terminal.cursorStyle", value: "bar", source: "settings-window" },
    });
  });

  it("persists and broadcasts a blink toggle (off-by-default → on)", () => {
    const bus = fakeBus();
    const store = makeSettingsStore(fakeStorage(), bus, "settings-window");
    render(<TerminalSettings settings={store} />);
    screen.getByRole("switch", { name: "Cursor Blink" }).click();
    expect(store.get("terminal.cursorBlink")).toBe(true);
    expect(bus.events).toContainEqual({
      event: SETTINGS_CHANGED_EVENT,
      payload: { key: "terminal.cursorBlink", value: true, source: "settings-window" },
    });
  });

  it("reflects persisted values on mount", () => {
    const store = makeSettingsStore(
      fakeStorage({
        "termixion.terminal.cursorStyle": "block",
        "termixion.terminal.cursorBlink": "true",
      }),
    );
    render(<TerminalSettings settings={store} />);
    expect((screen.getByRole("combobox", { name: "Cursor Style" }) as HTMLSelectElement).value).toBe(
      "block",
    );
    expect(screen.getByRole("switch", { name: "Cursor Blink" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

// trmx-144: the close-confirmation tri-state row — a SegmentedControl (Never / When busy / Always)
// over terminal.confirmClose, defaulting to "when-busy". Confirmation applies when closing a pane,
// a tab, or quitting; "When busy" prompts only when a program is still running.
describe("TerminalSettings confirm-before-closing row (trmx-144)", () => {
  it("renders the three options as a radiogroup and defaults to When busy", () => {
    render(<TerminalSettings settings={makeSettingsStore(fakeStorage())} />);
    expect(
      screen.getByRole("radiogroup", { name: "Confirm before closing" }),
    ).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Never", "When busy", "Always"]);
    expect(screen.getByRole("radio", { name: "When busy" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Never" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Always" })).toHaveAttribute("aria-checked", "false");
  });

  it("persists a selection via settings.set, broadcasts it, and reflects the new value", () => {
    const bus = fakeBus();
    const store = makeSettingsStore(fakeStorage(), bus, "settings-window");
    render(<TerminalSettings settings={store} />);
    fireEvent.click(screen.getByRole("radio", { name: "Always" }));
    expect(store.get("terminal.confirmClose")).toBe("always");
    expect(bus.events).toContainEqual({
      event: SETTINGS_CHANGED_EVENT,
      payload: { key: "terminal.confirmClose", value: "always", source: "settings-window" },
    });
    expect(screen.getByRole("radio", { name: "Always" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "When busy" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(screen.getByRole("radio", { name: "Never" }));
    expect(store.get("terminal.confirmClose")).toBe("never");
    expect(bus.events).toContainEqual({
      event: SETTINGS_CHANGED_EVENT,
      payload: { key: "terminal.confirmClose", value: "never", source: "settings-window" },
    });
  });

  it("reflects a persisted value on mount", () => {
    const store = makeSettingsStore(fakeStorage({ "termixion.terminal.confirmClose": "never" }));
    render(<TerminalSettings settings={store} />);
    expect(screen.getByRole("radio", { name: "Never" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "When busy" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});

// trmx-80 (FR-13): the scrollback/font trio below the cursor rows.
describe("TerminalSettings scrollback + font rows (trmx-80)", () => {
  it("shows the registry defaults: 10000 lines, empty family, 12 pt", () => {
    render(<TerminalSettings settings={makeSettingsStore(fakeStorage())} />);
    expect((screen.getByRole("textbox", { name: "Scrollback" }) as HTMLInputElement).value).toBe(
      "10000",
    );
    expect((screen.getByRole("textbox", { name: "Font Family" }) as HTMLInputElement).value).toBe(
      "",
    );
    expect((screen.getByRole("textbox", { name: "Font Size" }) as HTMLInputElement).value).toBe(
      "12",
    );
  });

  it("names the platform default stack in the Font Family placeholder", () => {
    render(<TerminalSettings settings={makeSettingsStore(fakeStorage())} />);
    const input = screen.getByRole("textbox", { name: "Font Family" }) as HTMLInputElement;
    expect(input.placeholder).toBe(ITERM2_FONT_FAMILY);
  });

  it("commits a scrollback change on blur, CLAMPED into the registry range, and broadcasts", () => {
    const bus = fakeBus();
    const store = makeSettingsStore(fakeStorage(), bus, "settings-window");
    render(<TerminalSettings settings={store} />);
    const input = screen.getByRole("textbox", { name: "Scrollback" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "999999" } }); // above the 200000 max
    fireEvent.blur(input);
    expect(input.value).toBe("200000");
    expect(store.get("terminal.scrollbackLines")).toBe(200_000);
    expect(bus.events).toContainEqual({
      event: SETTINGS_CHANGED_EVENT,
      payload: { key: "terminal.scrollbackLines", value: 200_000, source: "settings-window" },
    });
  });

  it("reverts junk scrollback input to the current value without persisting", () => {
    const bus = fakeBus();
    const store = makeSettingsStore(fakeStorage(), bus, "settings-window");
    render(<TerminalSettings settings={store} />);
    const input = screen.getByRole("textbox", { name: "Scrollback" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "lots" } });
    fireEvent.blur(input);
    expect(input.value).toBe("10000");
    expect(store.get("terminal.scrollbackLines")).toBe(10_000);
    expect(bus.events).toHaveLength(0);
  });

  it("commits a font family on Enter; clearing it commits '' (= the platform default)", () => {
    const bus = fakeBus();
    const store = makeSettingsStore(fakeStorage(), bus, "settings-window");
    render(<TerminalSettings settings={store} />);
    const input = screen.getByRole("textbox", { name: "Font Family" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "JetBrains Mono" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.get("terminal.fontFamily")).toBe("JetBrains Mono");
    expect(bus.events).toContainEqual({
      event: SETTINGS_CHANGED_EVENT,
      payload: { key: "terminal.fontFamily", value: "JetBrains Mono", source: "settings-window" },
    });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(store.get("terminal.fontFamily")).toBe("");
  });

  it("steps the font size with the ± stepper, persisting each step", () => {
    const store = makeSettingsStore(fakeStorage());
    render(<TerminalSettings settings={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase Font Size" }));
    expect(store.get("terminal.fontSize")).toBe(13);
    fireEvent.click(screen.getByRole("button", { name: "Decrease Font Size" }));
    fireEvent.click(screen.getByRole("button", { name: "Decrease Font Size" }));
    expect(store.get("terminal.fontSize")).toBe(11);
    expect((screen.getByRole("textbox", { name: "Font Size" }) as HTMLInputElement).value).toBe(
      "11",
    );
  });

  it("disables the stepper at the registry bounds (6–72)", () => {
    render(
      <TerminalSettings
        settings={makeSettingsStore(fakeStorage({ "termixion.terminal.fontSize": "72" }))}
      />,
    );
    expect(screen.getByRole("button", { name: "Increase Font Size" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decrease Font Size" })).not.toBeDisabled();
  });

  it("reflects persisted values on mount", () => {
    const store = makeSettingsStore(
      fakeStorage({
        "termixion.terminal.scrollbackLines": "50000",
        "termixion.terminal.fontFamily": "Menlo",
        "termixion.terminal.fontSize": "16",
      }),
    );
    render(<TerminalSettings settings={store} />);
    expect((screen.getByRole("textbox", { name: "Scrollback" }) as HTMLInputElement).value).toBe(
      "50000",
    );
    expect((screen.getByRole("textbox", { name: "Font Family" }) as HTMLInputElement).value).toBe(
      "Menlo",
    );
    expect((screen.getByRole("textbox", { name: "Font Size" }) as HTMLInputElement).value).toBe(
      "16",
    );
  });

  it("the Shell integration Reveal button invokes shell_integration_reveal (trmx-99)", () => {
    const invoke = vi.fn(() => Promise.resolve());
    render(<TerminalSettings settings={makeSettingsStore(fakeStorage())} invoke={invoke} />);
    expect(screen.getByText("Shell integration")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reveal snippets" }));
    expect(invoke).toHaveBeenCalledWith("shell_integration_reveal");
  });
});
