// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// First frontend test (D-2). The current App is the B-3 walking-skeleton placeholder, so this
// asserts that surface renders. When B-4 mounts the xterm.js terminal (and its Canvas/DOM
// fallback), that behavior is added here test-first per R8 — this file is the harness it grows in.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  it("renders the Termixion heading", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Termixion" }),
    ).toBeInTheDocument();
  });

  it("shows the walking-skeleton placeholder until the terminal lands (B-4)", () => {
    render(<App />);
    expect(screen.getByText(/walking skeleton \(v0\.0\.1\)/i)).toBeInTheDocument();
  });
});
