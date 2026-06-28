// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// App composition (D-2 + B-4). App's unit is what it composes: the title and the terminal surface.
// The terminal's own behavior is covered by TerminalView/mountTerminal tests, so TerminalView is
// stubbed here — that keeps this a pure composition test and avoids loading real xterm/WebGL in jsdom.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./terminal/TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));

import { App } from "./App";

describe("App", () => {
  it("renders the Termixion heading", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Termixion" }),
    ).toBeInTheDocument();
  });

  it("mounts the terminal surface", () => {
    render(<App />);
    expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
  });
});
