// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// App composition (D-2 + B-4 + B-5). App's unit is what it composes: the title, the backend handshake
// status, and the terminal surface. Their behaviors are covered by their own tests, so TerminalView
// and useBackend are stubbed here — keeping this a pure composition test with no real xterm/Tauri.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./terminal/TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));
vi.mock("./ipc/useBackend", () => ({
  useBackend: () => ({ coreVersion: "0.0.1" }),
}));

import { App } from "./App";

describe("App", () => {
  it("renders the Termixion heading", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Termixion" }),
    ).toBeInTheDocument();
  });

  it("shows the connected core version from the handshake", () => {
    render(<App />);
    expect(screen.getByTestId("core-version")).toHaveTextContent("core v0.0.1");
  });

  it("mounts the terminal surface", () => {
    render(<App />);
    expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
  });
});
