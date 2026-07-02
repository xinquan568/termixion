// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// App composition (D-2 + B-4 + B-5). App's unit is what it composes: the terminal surface owning the
// whole window (trmx-35 — no in-page chrome) plus the headless update authority (trmx-51; Settings
// lives in its own window now). TerminalView and useBackend behaviors are covered by their own tests,
// so they're stubbed here — keeping this a pure composition test.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./terminal/TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));
vi.mock("./ipc/useBackend", () => ({
  useBackend: () => ({ coreVersion: "0.0.1", attachTerminal: () => {} }),
}));
// trmx-51: UpdateAuthorityHost wires the real Tauri edges (updater client, event bus); stub it so
// this stays a pure composition test (its behavior is covered by the useUpdateAuthority spec).
vi.mock("./update/UpdateAuthorityHost", () => ({
  UpdateAuthorityHost: () => <div data-testid="update-authority-host" />,
}));

import { App } from "./App";

describe("App", () => {
  it("mounts the terminal surface and the headless update authority", () => {
    render(<App />);
    expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
    expect(screen.getByTestId("update-authority-host")).toBeInTheDocument();
  });

  it("renders no in-page chrome — the terminal owns the whole window (issue 1)", () => {
    render(<App />);
    // No program-name heading and no core-version status line.
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("core-version")).not.toBeInTheDocument();
  });
});
