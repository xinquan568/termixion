// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-253 (M20): COVERAGE. `PaletteOverlay` is the shared chassis behind BOTH the command palette
// (trmx-94) and the script picker (trmx-93), and until this file it had no test of its own — five of
// its paths survived only through whatever those two consumers happened to exercise:
// backdrop cancel, ArrowUp, the two navigation clamps, hover selection, and the reset-on-change
// effect. A consumer suite is free to stop covering them at any time without anyone noticing, and a
// generic component tested only through its callers is tested at their granularity, not its own.
//
// These are CHARACTERISATION tests: every behaviour asserted here is already implemented
// (PaletteOverlay.tsx `:69` reset effect, `:72` ArrowDown, `:75` ArrowUp, `:85` Escape, `:96`
// backdrop, `:120` hover), so they are expected to pass on their first run. That is correct under
// R8, which requires a RED first step for newly SPECIFIED behaviour — not for putting existing
// behaviour under direct test.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaletteOverlay } from "./PaletteOverlay";

interface Row {
  id: string;
  label: string;
}

// Module-level constants on purpose: `items` is a dependency of the reset effect (`:69`), so an
// inline literal would be a NEW array on every render and would reset the selection continuously,
// hiding the very navigation this file is here to pin. Two distinct arrays let the items-change
// test rerender with a genuinely different identity.
const ITEMS: Row[] = [
  { id: "a", label: "alpha" },
  { id: "b", label: "beta" },
  { id: "c", label: "gamma" },
  { id: "d", label: "delta" },
];
const OTHER_ITEMS: Row[] = [
  { id: "e", label: "epsilon" },
  { id: "z", label: "zeta" },
];

const filterKey = (row: Row) => row.label;
const itemKey = (row: Row) => row.id;
const renderItem = (row: Row) => <span>{row.label}</span>;

const setup = (items: Row[] = ITEMS) => {
  const onRun = vi.fn();
  const onCancel = vi.fn();
  const props = {
    filterKey,
    itemKey,
    renderItem,
    onRun,
    onCancel,
    placeholder: "Pick one…",
    dialogLabel: "Palette dialog",
    inputAriaLabel: "Filter rows",
    listAriaLabel: "Rows",
    emptyText: "Nothing here",
    testId: "palette",
    classPrefix: "tx-palette",
  };
  const view = render(<PaletteOverlay items={items} {...props} />);
  const rerenderWith = (next: Row[]) =>
    view.rerender(<PaletteOverlay items={next} {...props} />);
  return { onRun, onCancel, rerenderWith };
};

/** The 0-based index of the highlighted row, read off the rendered `aria-selected`. */
const selectedIndex = () =>
  screen.getAllByRole("option").findIndex((el) => el.getAttribute("aria-selected") === "true");

const root = () => screen.getByTestId("palette");
const press = (key: string) => fireEvent.keyDown(root(), { key });

// React synthesises `onMouseEnter` from the native mouseover/mouseout pair (EnterLeaveEventPlugin),
// so a dispatched "mouseenter" would never reach the handler — `mouseOver` is the one that does.
const hover = (el: Element) => fireEvent.mouseOver(el);

describe("PaletteOverlay: dismissal", () => {
  it("a mousedown on the backdrop itself cancels", () => {
    const { onCancel } = setup();
    fireEvent.mouseDown(root());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a mousedown INSIDE the dialog does not cancel (target !== currentTarget)", () => {
    const { onCancel } = setup();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.mouseDown(screen.getAllByRole("option")[1]);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Escape cancels", () => {
    const { onCancel } = setup();
    press("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("PaletteOverlay: keyboard navigation", () => {
  it("starts on the first row", () => {
    setup();
    expect(selectedIndex()).toBe(0);
  });

  it("ArrowUp moves the selection back toward the top", () => {
    setup();
    press("ArrowDown");
    press("ArrowDown");
    expect(selectedIndex()).toBe(2);
    press("ArrowUp");
    expect(selectedIndex()).toBe(1);
  });

  it("clamps at the top: ArrowUp on the first row stays on the first row", () => {
    setup();
    press("ArrowUp");
    press("ArrowUp");
    expect(selectedIndex()).toBe(0);
  });

  it("clamps at the bottom: ArrowDown past the last row stays on the last row", () => {
    const { onRun } = setup();
    for (let i = 0; i < ITEMS.length + 3; i++) press("ArrowDown");
    expect(selectedIndex()).toBe(ITEMS.length - 1);
    // The clamp must hold for the REF the Enter handler reads, not only for the rendered
    // highlight — an over-run index would silently run nothing.
    press("Enter");
    expect(onRun).toHaveBeenCalledWith(ITEMS[ITEMS.length - 1]);
  });

  it("with no matches at all, Enter is inert rather than running an undefined row", () => {
    const { onRun } = setup();
    fireEvent.change(screen.getByLabelText("Filter rows"), { target: { value: "zzzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    press("Enter");
    expect(onRun).not.toHaveBeenCalled();
  });
});

describe("PaletteOverlay: pointer selection", () => {
  it("hovering a row selects it", () => {
    setup();
    hover(screen.getAllByRole("option")[2]);
    expect(selectedIndex()).toBe(2);
  });

  it("a hover moves the ref too, so Enter runs the hovered row", () => {
    const { onRun } = setup();
    hover(screen.getAllByRole("option")[3]);
    press("Enter");
    expect(onRun).toHaveBeenCalledWith(ITEMS[3]);
  });

  it("clicking a row runs it", () => {
    const { onRun } = setup();
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(onRun).toHaveBeenCalledWith(ITEMS[1]);
  });
});

describe("PaletteOverlay: selection reset", () => {
  it("a new query re-selects the top result", () => {
    setup();
    press("ArrowDown");
    press("ArrowDown");
    expect(selectedIndex()).toBe(2);
    // Every row still matches "a", so the list length is unchanged — what moves is the selection.
    fireEvent.change(screen.getByLabelText("Filter rows"), { target: { value: "a" } });
    expect(screen.getAllByRole("option")).toHaveLength(ITEMS.length);
    expect(selectedIndex()).toBe(0);
  });

  it("a refreshed item list re-selects the top result (keeps the highlight in range)", () => {
    const { rerenderWith, onRun } = setup();
    press("ArrowDown");
    press("ArrowDown");
    press("ArrowDown");
    expect(selectedIndex()).toBe(3);
    // The shorter list would leave index 3 out of range if the effect did not reset it.
    rerenderWith(OTHER_ITEMS);
    expect(screen.getAllByRole("option")).toHaveLength(OTHER_ITEMS.length);
    expect(selectedIndex()).toBe(0);
    press("Enter");
    expect(onRun).toHaveBeenCalledWith(OTHER_ITEMS[0]);
  });
});
