// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// App composition (D-2 + B-4 + B-5). App's unit is what it composes: just the terminal surface, which
// now owns the whole window (trmx-35 — no in-page chrome). TerminalView and useBackend behaviors are
// covered by their own tests, so they're stubbed here — keeping this a pure composition test.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./terminal/TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));
vi.mock("./ipc/useBackend", () => ({
  useBackend: () => ({ coreVersion: "0.0.1", attachTerminal: () => {} }),
}));

import { App } from "./App";

describe("App", () => {
  it("mounts the terminal surface", () => {
    render(<App />);
    expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
  });

  it("renders no in-page chrome — the terminal owns the whole window (issue 1)", () => {
    render(<App />);
    // No program-name heading and no core-version status line.
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("core-version")).not.toBeInTheDocument();
  });
});
