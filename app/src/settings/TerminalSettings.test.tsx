// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the Terminal settings page spec — exactly the two red-boxed rows from the vmark
// screenshot (Cursor Style + Cursor Blink), vmark's option labels with cursor glyphs, trmx-51
// defaults (Underline, blink on), persistence through the settings store, and the settings:changed
// broadcast the live terminal consumes. R8: written before the page exists.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TerminalSettings } from "./TerminalSettings";
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
  it("renders exactly the two boxed rows — Cursor Style and Cursor Blink", () => {
    const store = makeSettingsStore(fakeStorage());
    const { container } = render(<TerminalSettings settings={store} />);
    expect(screen.getByText("Cursor Style")).toBeInTheDocument();
    expect(screen.getByText("Shape of the terminal cursor")).toBeInTheDocument();
    expect(screen.getByText("Cursor Blink")).toBeInTheDocument();
    expect(screen.getByText("Whether the terminal cursor blinks")).toBeInTheDocument();
    // ONLY these two rows for now (no Shell / Panel / Font Size / Line Height).
    expect(container.querySelectorAll(".tx-setting-row")).toHaveLength(2);
  });

  it("offers vmark's glyphed options and defaults to Underline", () => {
    const store = makeSettingsStore(fakeStorage());
    render(<TerminalSettings settings={store} />);
    const select = screen.getByRole("combobox", { name: "Cursor Style" }) as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.label);
    expect(labels).toEqual(["Bar │", "Block █", "Underline ▁"]);
    expect(select.value).toBe("underline");
  });

  it("defaults Cursor Blink to on", () => {
    const store = makeSettingsStore(fakeStorage());
    render(<TerminalSettings settings={store} />);
    expect(screen.getByRole("switch", { name: "Cursor Blink" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
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

  it("persists and broadcasts a blink toggle", () => {
    const bus = fakeBus();
    const store = makeSettingsStore(fakeStorage(), bus, "settings-window");
    render(<TerminalSettings settings={store} />);
    screen.getByRole("switch", { name: "Cursor Blink" }).click();
    expect(store.get("terminal.cursorBlink")).toBe(false);
    expect(bus.events).toContainEqual({
      event: SETTINGS_CHANGED_EVENT,
      payload: { key: "terminal.cursorBlink", value: false, source: "settings-window" },
    });
  });

  it("reflects persisted values on mount", () => {
    const store = makeSettingsStore(
      fakeStorage({
        "termixion.terminal.cursorStyle": "block",
        "termixion.terminal.cursorBlink": "false",
      }),
    );
    render(<TerminalSettings settings={store} />);
    expect((screen.getByRole("combobox", { name: "Cursor Style" }) as HTMLSelectElement).value).toBe(
      "block",
    );
    expect(screen.getByRole("switch", { name: "Cursor Blink" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});
