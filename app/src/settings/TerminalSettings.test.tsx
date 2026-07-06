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
import { describe, expect, it } from "vitest";
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
    // EXACTLY these seven rows (no Shell / Panel / Line Height).
    const rows = container.querySelectorAll(".tx-setting-row");
    expect(rows).toHaveLength(7);
    const labels = [...rows].map((r) => r.querySelector(".tx-setting-row__label")?.textContent);
    expect(labels).toEqual([
      "Cursor Style",
      "Cursor Blink",
      "Copy on Select",
      "Activity Indicator",
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
});
