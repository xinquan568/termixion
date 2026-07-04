// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the settings building-blocks spec — toggle/button interactions + progress width.
// trmx-80: NumberField (commit-on-blur/Enter numeric input, clamped, optional stepper) and
// TextField (commit-on-blur/Enter text input) for the FR-13 Terminal rows.
// trmx-81: SegmentedControl (an N-way single-choice with radiogroup semantics) for the FR-2.2
// Tab bar Position row.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  Button,
  NumberField,
  ProgressBar,
  SegmentedControl,
  Select,
  SettingRow,
  TextField,
  Toggle,
} from "./components";

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

describe("Select", () => {
  it("renders the options, reflects the value, and reports changes (trmx-51)", () => {
    const onChange = vi.fn();
    render(
      <Select
        value="underline"
        label="Cursor Style"
        options={[
          { value: "bar", label: "Bar │" },
          { value: "block", label: "Block █" },
          { value: "underline", label: "Underline ▁" },
        ]}
        onChange={onChange}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Cursor Style" }) as HTMLSelectElement;
    expect(select.value).toBe("underline");
    fireEvent.change(select, { target: { value: "bar" } });
    expect(onChange).toHaveBeenCalledWith("bar");
  });
});

describe("Button danger variant", () => {
  it("carries the danger class for the Reset styling (trmx-51)", () => {
    render(<Button variant="danger">Reset to Defaults</Button>);
    expect(screen.getByRole("button", { name: "Reset to Defaults" }).className).toContain(
      "tx-btn--danger",
    );
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

describe("NumberField (trmx-80)", () => {
  it("commits the typed value on blur, clamped into [min, max]", () => {
    const onCommit = vi.fn();
    render(<NumberField value={10} min={0} max={100} onCommit={onCommit} label="Scrollback" />);
    const input = screen.getByRole("textbox", { name: "Scrollback" }) as HTMLInputElement;
    expect(input.value).toBe("10");
    fireEvent.change(input, { target: { value: "250" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(100);
    expect(input.value).toBe("100"); // the field shows the clamped value it committed
  });

  it("commits on Enter", () => {
    const onCommit = vi.fn();
    render(<NumberField value={10} min={0} max={100} onCommit={onCommit} label="Scrollback" />);
    const input = screen.getByRole("textbox", { name: "Scrollback" });
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(42);
  });

  it("reverts junk input to the current value without committing", () => {
    const onCommit = vi.fn();
    render(<NumberField value={10} min={0} max={100} onCommit={onCommit} label="Scrollback" />);
    const input = screen.getByRole("textbox", { name: "Scrollback" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "lots" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("10");
  });

  it("reverts a FRACTIONAL draft like junk — integers only, nothing commits (trmx-80 review R4)", () => {
    // The backend's config_write rejects non-integers; committing 12.5 optimistically would
    // diverge the UI/session from the file, so the field refuses it at the source.
    const onCommit = vi.fn();
    render(<NumberField value={10} min={0} max={100} onCommit={onCommit} label="Scrollback" />);
    const input = screen.getByRole("textbox", { name: "Scrollback" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12.5" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("10");
    fireEvent.change(input, { target: { value: "0.5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("10");
  });

  it("skips a no-op commit (retyping the same value)", () => {
    const onCommit = vi.fn();
    render(<NumberField value={10} min={0} max={100} onCommit={onCommit} label="Scrollback" />);
    const input = screen.getByRole("textbox", { name: "Scrollback" });
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("renders stepper buttons that step by one and disable at the bounds", () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      <NumberField value={12} min={6} max={72} onCommit={onCommit} label="Font Size" stepper />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Increase Font Size" }));
    expect(onCommit).toHaveBeenCalledWith(13);
    fireEvent.click(screen.getByRole("button", { name: "Decrease Font Size" }));
    expect(onCommit).toHaveBeenCalledWith(11);
    rerender(<NumberField value={72} min={6} max={72} onCommit={onCommit} label="Font Size" stepper />);
    expect(screen.getByRole("button", { name: "Increase Font Size" })).toBeDisabled();
    rerender(<NumberField value={6} min={6} max={72} onCommit={onCommit} label="Font Size" stepper />);
    expect(screen.getByRole("button", { name: "Decrease Font Size" })).toBeDisabled();
  });

  it("syncs the field when the committed value changes from outside", () => {
    const { rerender } = render(
      <NumberField value={10} min={0} max={100} onCommit={vi.fn()} label="N" />,
    );
    rerender(<NumberField value={64} min={0} max={100} onCommit={vi.fn()} label="N" />);
    expect((screen.getByRole("textbox", { name: "N" }) as HTMLInputElement).value).toBe("64");
  });
});

describe("TextField (trmx-80)", () => {
  it("shows the placeholder and commits the typed value on blur", () => {
    const onCommit = vi.fn();
    render(
      <TextField value="" onCommit={onCommit} label="Font Family" placeholder="Menlo, monospace" />,
    );
    const input = screen.getByRole("textbox", { name: "Font Family" }) as HTMLInputElement;
    expect(input.placeholder).toBe("Menlo, monospace");
    fireEvent.change(input, { target: { value: "JetBrains Mono" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("JetBrains Mono");
  });

  it("commits on Enter and skips a no-op commit", () => {
    const onCommit = vi.fn();
    render(<TextField value="Menlo" onCommit={onCommit} label="Font Family" />);
    const input = screen.getByRole("textbox", { name: "Font Family" });
    fireEvent.keyDown(input, { key: "Enter" }); // unchanged → no commit
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" }); // clearing IS a change ("" = platform default)
    expect(onCommit).toHaveBeenCalledWith("");
  });

  it("syncs when the value changes from outside", () => {
    const { rerender } = render(<TextField value="a" onCommit={vi.fn()} label="T" />);
    rerender(<TextField value="b" onCommit={vi.fn()} label="T" />);
    expect((screen.getByRole("textbox", { name: "T" }) as HTMLInputElement).value).toBe("b");
  });
});

describe("SegmentedControl (trmx-81)", () => {
  const OPTIONS = [
    { value: "top", label: "Top" },
    { value: "bottom", label: "Bottom" },
    { value: "left", label: "Left" },
    { value: "right", label: "Right" },
  ] as const;

  it("renders radiogroup semantics: a labeled group, one radio per option, aria-checked on the value", () => {
    render(
      <SegmentedControl value="bottom" options={OPTIONS} label="Position" onChange={vi.fn()} />,
    );
    const group = screen.getByRole("radiogroup", { name: "Position" });
    const radios = screen.getAllByRole("radio");
    expect(group).toBeInTheDocument();
    expect(radios.map((r) => r.textContent)).toEqual(["Top", "Bottom", "Left", "Right"]);
    expect(screen.getByRole("radio", { name: "Bottom" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Top" })).toHaveAttribute("aria-checked", "false");
    // The active segment carries the styling modifier; the others don't.
    expect(screen.getByRole("radio", { name: "Bottom" }).className).toContain(
      "tx-segmented__segment--active",
    );
    expect(screen.getByRole("radio", { name: "Top" }).className).not.toContain(
      "tx-segmented__segment--active",
    );
  });

  it("reports a click on another segment and moves aria-checked when the value follows (controlled)", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SegmentedControl value="bottom" options={OPTIONS} label="Position" onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Left" }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("left");
    // Controlled: the checked state moves only when the owner feeds the new value back.
    rerender(
      <SegmentedControl value="left" options={OPTIONS} label="Position" onChange={onChange} />,
    );
    expect(screen.getByRole("radio", { name: "Left" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Bottom" })).toHaveAttribute("aria-checked", "false");
  });

  it("clicking the already-selected segment is a NO-OP (no redundant write/broadcast)", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl value="bottom" options={OPTIONS} label="Position" onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Bottom" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("roves the tabindex: only the selected segment is tabbable", () => {
    render(
      <SegmentedControl value="bottom" options={OPTIONS} label="Position" onChange={vi.fn()} />,
    );
    expect(screen.getByRole("radio", { name: "Bottom" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Top" })).toHaveAttribute("tabindex", "-1");
  });

  it("arrow keys step the selection (wrapping) and move focus with it", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl value="right" options={OPTIONS} label="Position" onChange={onChange} />,
    );
    // ArrowRight from the LAST option wraps to the first.
    fireEvent.keyDown(screen.getByRole("radio", { name: "Right" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("top");
    expect(screen.getByRole("radio", { name: "Top" })).toHaveFocus();
    // ArrowLeft steps backwards.
    fireEvent.keyDown(screen.getByRole("radio", { name: "Right" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("left");
  });
});

describe("SegmentedControl disabled (trmx-82)", () => {
  const OPTIONS = [
    { value: "horizontal", label: "Horizontal" },
    { value: "vertical", label: "Vertical" },
  ] as const;

  it("renders aria-disabled on the radiogroup AND every segment", () => {
    render(
      <SegmentedControl
        value="horizontal"
        options={OPTIONS}
        label="Orientation"
        onChange={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Orientation" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("the ENABLED render carries no aria-disabled anywhere (the enabled path is unchanged)", () => {
    render(
      <SegmentedControl
        value="horizontal"
        options={OPTIONS}
        label="Orientation"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Orientation" })).not.toHaveAttribute(
      "aria-disabled",
    );
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toHaveAttribute("aria-disabled");
    }
  });

  it("never fires onChange while disabled: clicks and arrow keys are inert", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        value="horizontal"
        options={OPTIONS}
        label="Orientation"
        onChange={onChange}
        disabled
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Vertical" }));
    fireEvent.keyDown(screen.getByRole("radio", { name: "Horizontal" }), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("radio", { name: "Horizontal" }), { key: "ArrowLeft" });
    expect(onChange).not.toHaveBeenCalled();
    // The selection never moved either — still the controlled value.
    expect(screen.getByRole("radio", { name: "Horizontal" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("removes EVERY segment from the tab order while disabled (even the selected one)", () => {
    render(
      <SegmentedControl
        value="horizontal"
        options={OPTIONS}
        label="Orientation"
        onChange={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByRole("radio", { name: "Horizontal" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("radio", { name: "Vertical" })).toHaveAttribute("tabindex", "-1");
  });

  it("re-enables cleanly: the roving tabindex returns and changes report again", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SegmentedControl
        value="horizontal"
        options={OPTIONS}
        label="Orientation"
        onChange={onChange}
        disabled
      />,
    );
    rerender(
      <SegmentedControl
        value="horizontal"
        options={OPTIONS}
        label="Orientation"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Orientation" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByRole("radio", { name: "Horizontal" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Vertical" })).toHaveAttribute("tabindex", "-1");
    fireEvent.click(screen.getByRole("radio", { name: "Vertical" }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("vertical");
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
