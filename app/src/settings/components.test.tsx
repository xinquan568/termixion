// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the settings building-blocks spec — toggle/button interactions + progress width.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, ProgressBar, SettingRow, Toggle } from "./components";

describe("Toggle", () => {
  it("reflects checked state and calls onChange with the negation", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Toggle checked={false} onChange={onChange} label="Auto" />);
    const sw = screen.getByRole("switch", { name: "Auto" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    sw.click();
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Toggle checked onChange={onChange} label="Auto" />);
    expect(screen.getByRole("switch", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("Button", () => {
  it("fires onClick and honors disabled", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    screen.getByRole("button", { name: "Go" }).click();
    expect(onClick).toHaveBeenCalledOnce();

    rerender(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    );
    screen.getByRole("button", { name: "Go" }).click();
    expect(onClick).toHaveBeenCalledOnce(); // still once — disabled swallows the click
  });
});

describe("ProgressBar", () => {
  it("sets the fill width and ARIA value to the percent", () => {
    render(<ProgressBar percent={42} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar.querySelector<HTMLElement>(".tx-progress__fill")!.style.width).toBe("42%");
  });
});

describe("SettingRow", () => {
  it("renders label, optional description, and control", () => {
    render(
      <SettingRow label="Auto update" description="check on launch">
        <span data-testid="ctl" />
      </SettingRow>,
    );
    expect(screen.getByText("Auto update")).toBeInTheDocument();
    expect(screen.getByText("check on launch")).toBeInTheDocument();
    expect(screen.getByTestId("ctl")).toBeInTheDocument();
  });
});
