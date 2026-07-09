// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-171: the theme swatch context menu (a small in-DOM popover). jsdom has no layout, so the
// clamp geometry is covered by the Playwright settings e2e; here we pin the behavior it CAN see:
// the menu renders at the given x/y, the Duplicate item fires onDuplicate then onClose, and the
// popover dismisses on Escape and on an OUTSIDE pointerdown (not an inside one) — with its document
// listeners torn down on unmount so a post-unmount key/pointer event never calls a stale handler.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ThemeContextMenu } from "./ThemeContextMenu";

describe("ThemeContextMenu (trmx-171)", () => {
  it("renders a role=menu at the given x/y with a single Duplicate menuitem", () => {
    render(<ThemeContextMenu x={120} y={40} label="Night" onDuplicate={vi.fn()} onClose={vi.fn()} />);
    const menu = screen.getByRole("menu");
    expect(menu.style.position).toBe("fixed");
    expect(menu.style.left).toBe("120px");
    expect(menu.style.top).toBe("40px");
    expect(screen.getByRole("menuitem", { name: /duplicate/i })).toBeInTheDocument();
  });

  it("the Duplicate item calls onDuplicate then onClose", () => {
    const order: string[] = [];
    const onDuplicate = vi.fn(() => order.push("dup"));
    const onClose = vi.fn(() => order.push("close"));
    render(<ThemeContextMenu x={0} y={0} label="Night" onDuplicate={onDuplicate} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: /duplicate/i }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["dup", "close"]);
  });

  it("Escape closes the menu", () => {
    const onClose = vi.fn();
    render(<ThemeContextMenu x={0} y={0} onDuplicate={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an OUTSIDE pointerdown closes it; an inside one does not", () => {
    const onClose = vi.fn();
    render(
      <div>
        <button type="button" data-testid="outside">
          outside
        </button>
        <ThemeContextMenu x={0} y={0} onDuplicate={vi.fn()} onClose={onClose} />
      </div>,
    );
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: /duplicate/i })); // inside
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByTestId("outside")); // outside
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("removes its document listeners on unmount (no stale handler after unmount)", () => {
    const onClose = vi.fn();
    const { unmount } = render(<ThemeContextMenu x={0} y={0} onDuplicate={vi.fn()} onClose={onClose} />);
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });
});
