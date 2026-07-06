// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-93 (FR-5, test-first): the script picker overlay — keyboard-first fuzzy list. Type to filter,
// ↑/↓ to move, Enter to run, Esc/backdrop to cancel. Catalog rides an injected `invoke` fake.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScriptPicker } from "./ScriptPicker";
import type { InvokeFn } from "../ipc/backend";

const SCRIPTS = [
  { relPath: "tools/build.sh", name: "build", sourceLine: "source '/x/tools/build.sh'" },
  { relPath: "work/proj-x.sh", name: "proj-x", sourceLine: "source '/x/work/proj-x.sh'" },
  { relPath: "work/proj-y.sh", name: "proj-y", sourceLine: "source '/x/work/proj-y.sh'" },
];

function fakeInvoke(entries = SCRIPTS): InvokeFn {
  return vi.fn(async (cmd: string) => (cmd === "scripts_list" ? entries : undefined)) as unknown as InvokeFn;
}

async function renderPicker(onRun = vi.fn(), onCancel = vi.fn(), entries = SCRIPTS) {
  render(<ScriptPicker onRun={onRun} onCancel={onCancel} invoke={fakeInvoke(entries)} />);
  // wait for the async catalog load
  await waitFor(() => expect(screen.getAllByRole("option").length).toBe(entries.length));
  return { onRun, onCancel };
}

describe("ScriptPicker (trmx-93)", () => {
  it("lists the scripts folders-first and highlights the first by default", async () => {
    await renderPicker();
    const options = screen.getAllByRole("option");
    expect(options.map((o) => within(o).getByText(/\.sh$/).textContent)).toEqual([
      "tools/build.sh",
      "work/proj-x.sh",
      "work/proj-y.sh",
    ]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("fuzzy-filters as you type", async () => {
    await renderPicker();
    fireEvent.change(screen.getByLabelText("Filter scripts"), { target: { value: "projx" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(within(options[0]).getByText("work/proj-x.sh")).toBeInTheDocument();
  });

  it("↓ moves the selection and Enter runs the highlighted script", async () => {
    const { onRun } = await renderPicker();
    const overlay = screen.getByTestId("script-picker");
    fireEvent.keyDown(overlay, { key: "ArrowDown" });
    fireEvent.keyDown(overlay, { key: "Enter" });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0].relPath).toBe("work/proj-x.sh");
  });

  it("Enter after a filter runs the top match", async () => {
    const { onRun } = await renderPicker();
    fireEvent.change(screen.getByLabelText("Filter scripts"), { target: { value: "build" } });
    fireEvent.keyDown(screen.getByTestId("script-picker"), { key: "Enter" });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0].relPath).toBe("tools/build.sh");
  });

  it("Esc cancels", async () => {
    const { onCancel } = await renderPicker();
    fireEvent.keyDown(screen.getByTestId("script-picker"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a click on an item runs it", async () => {
    const { onRun } = await renderPicker();
    fireEvent.click(within(screen.getAllByRole("option")[1]).getByText("work/proj-x.sh"));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0].relPath).toBe("work/proj-x.sh");
  });

  it("shows an empty hint when there are no scripts", async () => {
    render(<ScriptPicker onRun={vi.fn()} onCancel={vi.fn()} invoke={fakeInvoke([])} />);
    await waitFor(() =>
      expect(screen.getByText(/add files to ~\/.config\/termixion\/scripts/i)).toBeInTheDocument(),
    );
  });
});
