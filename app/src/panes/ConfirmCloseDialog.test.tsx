// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-144 (test-first): the confirm-before-close dialog. Kitty-style y/n keys plus a real focus
// story: Cancel is focused on mount (Enter is SAFE by default — it cancels), Enter only ever
// activates the FOCUSED button, and Tab/Shift+Tab cycle the three controls (a minimal trap so a
// modal over a terminal never leaks focus). Every handled key is swallowed (preventDefault +
// stopPropagation) so it cannot fall through to the terminal / app keymap underneath.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmCloseDialog, type ConfirmCloseDialogProps } from "./ConfirmCloseDialog";

const setup = (over: Partial<ConfirmCloseDialogProps> = {}) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const parentKeyDown = vi.fn();
  render(
    <div onKeyDown={parentKeyDown}>
      <ConfirmCloseDialog
        kind="pane"
        names={[]}
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...over}
      />
    </div>,
  );
  return { onConfirm, onCancel, parentKeyDown, dialog: screen.getByRole("alertdialog") };
};

describe("ConfirmCloseDialog rendering (trmx-144)", () => {
  it("renders the pane question with no program line when names is empty (the `always` case)", () => {
    const { dialog } = setup({ kind: "pane", names: [] });
    expect(dialog).toHaveAccessibleName("Confirm close pane");
    expect(screen.getByText("Close this pane?")).toBeInTheDocument();
    expect(screen.queryByText(/running/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("renders a single program name inline in code style for a tab close", () => {
    const { dialog } = setup({ kind: "tab", names: ["vim"] });
    expect(dialog).toHaveAccessibleName("Confirm close tab");
    expect(screen.getByText("Close this tab?")).toBeInTheDocument();
    const code = screen.getByText("vim");
    expect(code.tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: "Close Tab" })).toBeInTheDocument();
  });

  it("joins up to three names and folds the rest into +N more", () => {
    setup({ kind: "tab", names: ["vim", "cargo", "top", "ssh", "htop"] });
    expect(screen.getByText(/vim, cargo, top \+2 more/)).toBeInTheDocument();
    expect(screen.queryByText(/ssh/)).not.toBeInTheDocument();
  });

  it("renders the quit dialog with the running-programs line", () => {
    const { dialog } = setup({ kind: "quit", names: ["vim", "cargo"] });
    expect(dialog).toHaveAccessibleName("Confirm quit");
    expect(screen.getByText("Quit Termixion?")).toBeInTheDocument();
    expect(screen.getByText(/vim, cargo/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quit" })).toBeInTheDocument();
  });

  it("has an unchecked 'Don't ask me again' checkbox by default", () => {
    setup();
    expect(screen.getByRole("checkbox", { name: /don't ask me again/i })).not.toBeChecked();
  });
});

describe("ConfirmCloseDialog keys (trmx-144)", () => {
  it("focuses Cancel on mount (Enter is safe by default)", () => {
    setup();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("y confirms with dontAskAgain=false when the checkbox is untouched", () => {
    const { onConfirm, onCancel, dialog } = setup();
    fireEvent.keyDown(dialog, { key: "y" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(false);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Y (shifted) also confirms", () => {
    const { onConfirm, dialog } = setup();
    fireEvent.keyDown(dialog, { key: "Y" });
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("checkbox checked + y confirms with dontAskAgain=true", () => {
    const { onConfirm, dialog } = setup();
    fireEvent.click(screen.getByRole("checkbox", { name: /don't ask me again/i }));
    fireEvent.keyDown(dialog, { key: "y" });
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("n cancels", () => {
    const { onConfirm, onCancel, dialog } = setup();
    fireEvent.keyDown(dialog, { key: "n" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Escape cancels", () => {
    const { onCancel, dialog } = setup();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Enter activates the FOCUSED button — initially Cancel, so it cancels (never a global confirm)", () => {
    const { onConfirm, onCancel, dialog } = setup();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Enter on the focused destructive button confirms with the checkbox state", () => {
    const { onConfirm, onCancel, dialog } = setup({ kind: "quit", names: ["vim"] });
    fireEvent.click(screen.getByRole("checkbox", { name: /don't ask me again/i }));
    screen.getByRole("button", { name: "Quit" }).focus();
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(true);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Enter with the checkbox focused neither confirms nor cancels", () => {
    const { onConfirm, onCancel, dialog } = setup();
    screen.getByRole("checkbox", { name: /don't ask me again/i }).focus();
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Tab cycles focus forward through Cancel -> confirm -> checkbox -> Cancel (kept inside)", () => {
    const { dialog } = setup();
    const checkbox = screen.getByRole("checkbox", { name: /don't ask me again/i });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Close" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(checkbox).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(cancel).toHaveFocus();
  });

  it("Shift+Tab cycles focus backward (Cancel -> checkbox)", () => {
    const { dialog } = setup();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("checkbox", { name: /don't ask me again/i })).toHaveFocus();
  });

  it("swallows every handled key: preventDefault + no propagation to a parent listener", () => {
    const { parentKeyDown, dialog } = setup();
    for (const init of [
      { key: "y" },
      { key: "n" },
      { key: "Escape" },
      { key: "Enter" },
      { key: "Tab" },
      { key: "Tab", shiftKey: true },
    ]) {
      // fireEvent returns false when preventDefault was called on the event.
      expect(fireEvent.keyDown(dialog, init)).toBe(false);
    }
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("lets an unhandled key propagate (the trap is selective)", () => {
    const { parentKeyDown, dialog } = setup();
    fireEvent.keyDown(dialog, { key: "a" });
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
  });
});

describe("ConfirmCloseDialog backdrop (trmx-144)", () => {
  it("mousedown on the backdrop cancels", () => {
    const { onCancel } = setup();
    fireEvent.mouseDown(screen.getByTestId("confirm-close"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("mousedown inside the dialog box does NOT cancel", () => {
    const { onCancel, dialog } = setup();
    fireEvent.mouseDown(dialog);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("clicking the buttons fires the callbacks (confirm carries the checkbox state)", () => {
    const { onConfirm, onCancel } = setup({ kind: "pane", names: ["vim"] });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("checkbox", { name: /don't ask me again/i }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });
});
