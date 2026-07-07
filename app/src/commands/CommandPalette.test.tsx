// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { bindingFor, CommandPalette, orderedCommands } from "./CommandPalette";
import { buildCommands, type CommandContext } from "./registry";
import type { InvokeFn } from "../ipc/backend";

const ctx = { tabCount: () => 5, paneCount: () => 3 } as unknown as CommandContext;
const KEYMAP = { "cmd+t": "tab.new", "cmd+shift+p": "app.command-palette", "cmd+d": "pane.split-right" };
const THEMES = [{ id: "night", title: "Night" }, { id: "white", title: "White" }];

describe("bindingFor (pure)", () => {
  it("reverse-looks-up a command's chord, or undefined", () => {
    expect(bindingFor("tab.new", KEYMAP)).toBe("cmd+t");
    expect(bindingFor("pane.split-right", KEYMAP)).toBe("cmd+d");
    expect(bindingFor("tab.rename", KEYMAP)).toBeUndefined();
  });
});

describe("orderedCommands (pure)", () => {
  it("hides when-false commands and puts recent first", () => {
    const commands = buildCommands();
    const fewTabs = { ...ctx, tabCount: () => 2 } as CommandContext;
    const ordered = orderedCommands(commands, ["pane.split-right"], fewTabs);
    const ids = ordered.map((c) => c.id);
    expect(ids[0]).toBe("pane.split-right"); // MRU first
    expect(ids).not.toContain("tab.select-8"); // when(2 tabs) → false, hidden (needs 8 tabs)
    expect(ids).toContain("tab.select-1");
    expect(ids).not.toContain("tab.select-9"); // trmx-151: strict ninth tab — hidden until 9 tabs exist
  });
});

describe("CommandPalette", () => {
  const setup = (over: Partial<React.ComponentProps<typeof CommandPalette>> = {}) => {
    const dispatch = vi.fn();
    const onClose = vi.fn();
    const invoke = vi.fn(async () => []) as unknown as InvokeFn;
    render(
      <CommandPalette
        commands={buildCommands()}
        dispatch={dispatch}
        recentCommandIds={[]}
        ctx={ctx}
        keymap={KEYMAP}
        themes={THEMES}
        invoke={invoke}
        onClose={onClose}
        {...over}
      />,
    );
    return { dispatch, onClose };
  };

  it("lists commands with their binding hint and runs a plain command through dispatch", () => {
    const { dispatch, onClose } = setup();
    fireEvent.change(screen.getByLabelText("Filter commands"), { target: { value: "split right" } });
    const options = screen.getAllByRole("option");
    expect(within(options[0]).getByText("Split Right")).toBeInTheDocument();
    expect(within(options[0]).getByText("cmd+d")).toBeInTheDocument(); // the binding hint
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "Enter" });
    expect(dispatch).toHaveBeenCalledWith("pane.split-right");
    expect(onClose).toHaveBeenCalled();
  });

  it("a parameterized command (theme.select) drills into a second themes page", async () => {
    const { dispatch, onClose } = setup();
    fireEvent.change(screen.getByLabelText("Filter commands"), { target: { value: "change theme" } });
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "Enter" });
    // second page
    const param = await screen.findByTestId("command-palette-param");
    expect(within(param).getByText("Night")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter themes"), { target: { value: "night" } });
    fireEvent.keyDown(param, { key: "Enter" });
    expect(dispatch).toHaveBeenCalledWith("theme.select", "night");
    expect(onClose).toHaveBeenCalled();
  });

  it("Esc on the main page closes; Esc on a param page goes back", async () => {
    const { onClose } = setup();
    fireEvent.change(screen.getByLabelText("Filter commands"), { target: { value: "change theme" } });
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "Enter" });
    const param = await screen.findByTestId("command-palette-param");
    fireEvent.keyDown(param, { key: "Escape" }); // back, not close
    expect(onClose).not.toHaveBeenCalled();
    await screen.findByTestId("command-palette");
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "Escape" }); // now close
    expect(onClose).toHaveBeenCalled();
  });
});
