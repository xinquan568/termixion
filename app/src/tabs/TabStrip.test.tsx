// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-74 (test-first): the tab strip — a PRESENTATIONAL bottom bar over the pure tab model. It
// renders the tabs + a `+` button and reports intent upward (activate / close / new / move); it
// owns NO tab state. The drag-to-reorder math lives in the exported `hoverIndexFromPoint` helper
// (unit-tested directly, like the reducer), while the DOM wiring is driven here with jsdom pointer
// sequences (getBoundingClientRect mocked — jsdom has no layout).
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabStrip, hoverIndexFromPoint, hoverSlotFor, DRAG_SLOP_PX } from "./TabStrip";
import type { Tab } from "./tabState";

function tab(tabId: number, title: string): Tab {
  // trmx-75: `Tab` carries its title sources; the strip renders `title` only, so seeding the
  // fallback from it keeps these fixtures shape-valid without changing what is exercised.
  return { tabId, title, titleSources: { fallback: title }, pane: { sessionId: null } };
}

function renderStrip(overrides: Partial<Parameters<typeof TabStrip>[0]> = {}) {
  const props = {
    tabs: [tab(1, "Shell"), tab(2, "vim"), tab(3, "build")],
    activeTabId: 2,
    // trmx-75: rename is App-owned state reported upward, like every other intent.
    renamingTabId: null as number | null,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onMove: vi.fn(),
    onRenameStart: vi.fn(),
    onRenameCommit: vi.fn(),
    onRenameCancel: vi.fn(),
    ...overrides,
  };
  const view = render(<TabStrip {...props} />);
  return { view, ...props };
}

// jsdom measures every element 0×0; give the three tabs side-by-side 100px-wide rects so the
// drag math sees a real strip layout (tab i spans [i*100, i*100+100)).
function layOutTabs() {
  for (const [i, id] of [1, 2, 3].entries()) {
    screen.getByTestId(`tab-${id}`).getBoundingClientRect = () =>
      ({ left: i * 100, width: 100, right: i * 100 + 100, top: 0, bottom: 34, height: 34, x: i * 100, y: 0, toJSON: () => ({}) }) as DOMRect;
  }
}

// trmx-81: the vertical rail — tab i spans [i*30, i*30+30) on Y, full 180px rail width.
function layOutTabsVertically() {
  for (const [i, id] of [1, 2, 3].entries()) {
    screen.getByTestId(`tab-${id}`).getBoundingClientRect = () =>
      ({ left: 0, width: 180, right: 180, top: i * 30, bottom: i * 30 + 30, height: 30, x: 0, y: i * 30, toJSON: () => ({}) }) as DOMRect;
  }
}

describe("hoverIndexFromPoint", () => {
  const rects = [
    { left: 0, width: 100 },
    { left: 100, width: 100 },
    { left: 200, width: 100 },
  ];

  it("is 0 left of the first midpoint (including negative x)", () => {
    expect(hoverIndexFromPoint(rects, 10)).toBe(0);
    expect(hoverIndexFromPoint(rects, -50)).toBe(0);
  });

  it("is the slot whose midpoint bounds x from the right", () => {
    expect(hoverIndexFromPoint(rects, 60)).toBe(1); // past mid(0)=50, before mid(1)=150
    expect(hoverIndexFromPoint(rects, 160)).toBe(2); // past mid(1)=150, before mid(2)=250
  });

  it("clamps to the last slot past the last midpoint", () => {
    expect(hoverIndexFromPoint(rects, 260)).toBe(2);
    expect(hoverIndexFromPoint(rects, 9999)).toBe(2);
  });

  it("is 0 for an empty strip (defensive)", () => {
    expect(hoverIndexFromPoint([], 123)).toBe(0);
  });
});

// trmx-81: the axis-generalized slot math — midpoints on x for horizontal strips, on y for
// vertical rails. hoverIndexFromPoint delegates here, so the x-axis semantics are ONE code path.
describe("hoverSlotFor", () => {
  // Three rects laid out BOTH ways at once (x: 100px columns, y: 30px rows) so each axis's pick
  // provably reads only its own coordinates.
  const rects = [
    { left: 0, top: 0, width: 100, height: 30 },
    { left: 100, top: 30, width: 100, height: 30 },
    { left: 200, top: 60, width: 100, height: 30 },
  ];

  it("x axis: midpoint crossings and first/last boundaries (hoverIndexFromPoint semantics)", () => {
    expect(hoverSlotFor(10, rects, "x")).toBe(0);
    expect(hoverSlotFor(-50, rects, "x")).toBe(0); // before the first midpoint clamps to 0
    expect(hoverSlotFor(49, rects, "x")).toBe(0); // just under mid(0)=50
    expect(hoverSlotFor(60, rects, "x")).toBe(1); // past mid(0), before mid(1)=150
    expect(hoverSlotFor(160, rects, "x")).toBe(2); // past mid(1), before mid(2)=250
    expect(hoverSlotFor(9999, rects, "x")).toBe(2); // past the last midpoint clamps to last
  });

  it("y axis: midpoint crossings and first/last boundaries", () => {
    expect(hoverSlotFor(10, rects, "y")).toBe(0); // before mid(0)=15
    expect(hoverSlotFor(-5, rects, "y")).toBe(0);
    expect(hoverSlotFor(20, rects, "y")).toBe(1); // past mid(0), before mid(1)=45
    expect(hoverSlotFor(50, rects, "y")).toBe(2); // past mid(1), before mid(2)=75
    expect(hoverSlotFor(9999, rects, "y")).toBe(2); // clamps to the last slot
  });

  it("is 0 for an empty strip on either axis (defensive)", () => {
    expect(hoverSlotFor(123, [], "x")).toBe(0);
    expect(hoverSlotFor(123, [], "y")).toBe(0);
  });
});

describe("TabStrip", () => {
  it("renders every tab (title + tooltip + close) and the + button under stable testids", () => {
    renderStrip();
    expect(screen.getByTestId("tab-strip")).toBeInTheDocument();
    for (const [id, title] of [
      [1, "Shell"],
      [2, "vim"],
      [3, "build"],
    ] as const) {
      const el = screen.getByTestId(`tab-${id}`);
      expect(el).toHaveTextContent(title);
      // The truncated title carries the full text as a tooltip.
      expect(screen.getByTitle(title)).toBeInTheDocument();
      // The close button is ALWAYS in the DOM (visibility is CSS hover-only).
      expect(screen.getByTestId(`tab-close-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("tab-new")).toBeInTheDocument();
  });

  it("marks exactly the active tab with the active class", () => {
    renderStrip({ activeTabId: 2 });
    expect(screen.getByTestId("tab-2").className).toContain("tab-strip__tab--active");
    expect(screen.getByTestId("tab-1").className).not.toContain("tab-strip__tab--active");
    expect(screen.getByTestId("tab-3").className).not.toContain("tab-strip__tab--active");
  });

  it("a click (pointer down+up without slop) activates the tab", () => {
    const { onActivate, onMove } = renderStrip();
    const el = screen.getByTestId("tab-1");
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 50, clientY: 10, button: 0 });
    // Sub-slop jitter stays a click.
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 50 + DRAG_SLOP_PX - 1, clientY: 10 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 50 + DRAG_SLOP_PX - 1, clientY: 10 });
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(1);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("Enter/Space on a focused tab activates it (keyboard path)", () => {
    const { onActivate } = renderStrip();
    fireEvent.keyDown(screen.getByTestId("tab-3"), { key: "Enter" });
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("× closes its tab WITHOUT also activating it (stopPropagation)", () => {
    const { onActivate, onClose } = renderStrip();
    const close = screen.getByTestId("tab-close-3");
    // A real user's click carries the pointer sequence; none of it may start a tab drag/activate.
    fireEvent.pointerDown(close, { pointerId: 1, clientX: 290, clientY: 10, button: 0 });
    fireEvent.pointerUp(close, { pointerId: 1, clientX: 290, clientY: 10 });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(3);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("+ requests a new tab", () => {
    const { onNew } = renderStrip();
    fireEvent.click(screen.getByTestId("tab-new"));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("a pointer drag past a neighbor's midpoint moves the tab once (and does not activate)", () => {
    const { onActivate, onMove } = renderStrip();
    layOutTabs();
    const el = screen.getByTestId("tab-1"); // index 0
    fireEvent.pointerDown(el, { pointerId: 7, clientX: 50, clientY: 10, button: 0 });
    // Cross the slop, then sweep to x=260 — past tab-3's midpoint (250) → hover index 2.
    fireEvent.pointerMove(el, { pointerId: 7, clientX: 120, clientY: 12 });
    fireEvent.pointerMove(el, { pointerId: 7, clientX: 260, clientY: 12 });
    fireEvent.pointerUp(el, { pointerId: 7, clientX: 260, clientY: 12 });
    expect(onMove).toHaveBeenCalledExactlyOnceWith(0, 2);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("a drag that returns to its own slot moves nothing (no spurious onMove)", () => {
    const { onActivate, onMove } = renderStrip();
    layOutTabs();
    const el = screen.getByTestId("tab-2"); // index 1, spans [100, 200)
    fireEvent.pointerDown(el, { pointerId: 3, clientX: 150, clientY: 10, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 3, clientX: 190, clientY: 10 }); // slop exceeded
    fireEvent.pointerMove(el, { pointerId: 3, clientX: 149, clientY: 10 }); // back home
    fireEvent.pointerUp(el, { pointerId: 3, clientX: 149, clientY: 10 });
    expect(onMove).not.toHaveBeenCalled();
    // Slop was exceeded, so it was a drag — not a click; no activation either.
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("pointercancel aborts a drag entirely", () => {
    const { onActivate, onMove } = renderStrip();
    layOutTabs();
    const el = screen.getByTestId("tab-1");
    fireEvent.pointerDown(el, { pointerId: 5, clientX: 50, clientY: 10, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 5, clientX: 260, clientY: 10 });
    fireEvent.pointerCancel(el, { pointerId: 5 });
    fireEvent.pointerUp(el, { pointerId: 5, clientX: 260, clientY: 10 });
    expect(onMove).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });
});

// trmx-81 (FR-2.2): the vertical rail. `orientation="vertical"` flips the drag axis to Y (the
// slop and capture semantics are unchanged) and adds the modifier class the side-rail CSS keys on.
describe("TabStrip vertical orientation (trmx-81)", () => {
  it("defaults to horizontal: no vertical modifier class without the prop", () => {
    renderStrip();
    expect(screen.getByTestId("tab-strip").className).toBe("tab-strip");
  });

  it("carries the vertical modifier class when orientation is vertical", () => {
    renderStrip({ orientation: "vertical" });
    expect(screen.getByTestId("tab-strip").className).toBe("tab-strip tab-strip--vertical");
  });

  it("a vertical pointer drag past a neighbor's Y midpoint commits ONE onMove (and no activate)", () => {
    const { onActivate, onMove } = renderStrip({ orientation: "vertical" });
    layOutTabsVertically();
    const el = screen.getByTestId("tab-1"); // index 0, spans [0, 30) on Y
    fireEvent.pointerDown(el, { pointerId: 9, clientX: 90, clientY: 15, button: 0 });
    // Cross the slop on Y, then sweep to y=80 — past tab-3's midpoint (75) → hover slot 2.
    fireEvent.pointerMove(el, { pointerId: 9, clientX: 90, clientY: 40 });
    fireEvent.pointerMove(el, { pointerId: 9, clientX: 90, clientY: 80 });
    fireEvent.pointerUp(el, { pointerId: 9, clientX: 90, clientY: 80 });
    expect(onMove).toHaveBeenCalledExactlyOnceWith(0, 2);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("a sub-slop vertical click still activates (the click-vs-drag contract holds on Y)", () => {
    const { onActivate, onMove } = renderStrip({ orientation: "vertical" });
    layOutTabsVertically();
    const el = screen.getByTestId("tab-2");
    fireEvent.pointerDown(el, { pointerId: 4, clientX: 90, clientY: 45, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 4, clientX: 90, clientY: 45 + DRAG_SLOP_PX - 1 });
    fireEvent.pointerUp(el, { pointerId: 4, clientX: 90, clientY: 45 + DRAG_SLOP_PX - 1 });
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(2);
    expect(onMove).not.toHaveBeenCalled();
  });
});

// trmx-81 D2: the drop indicator — a rendered 2px accent line at the hover-slot boundary, visible
// only mid-drag. On a horizontal strip it is a VERTICAL line at the slot's x; on a vertical rail
// a HORIZONTAL line at the slot's y. Class-based (axis modifier) so tests/e2e can pin both.
describe("TabStrip drop indicator (trmx-81 D2)", () => {
  const indicator = () => screen.queryByTestId("tab-strip-indicator");

  it("appears once a horizontal drag starts, at the hover slot's LEFT boundary, and clears on release", () => {
    renderStrip();
    layOutTabs();
    const el = screen.getByTestId("tab-1");
    fireEvent.pointerDown(el, { pointerId: 6, clientX: 50, clientY: 10, button: 0 });
    expect(indicator()).toBeNull(); // not before the slop — a click renders nothing
    fireEvent.pointerMove(el, { pointerId: 6, clientX: 260, clientY: 10 }); // hover slot 2
    const line = indicator();
    expect(line).not.toBeNull();
    expect(line!.className).toContain("tab-strip__indicator");
    expect(line!.className).toContain("tab-strip__indicator--horizontal");
    expect(line!.style.left).toBe("200px"); // slot 2's boundary (rect.left), strip at x=0
    fireEvent.pointerUp(el, { pointerId: 6, clientX: 260, clientY: 10 });
    expect(indicator()).toBeNull(); // cleared on release
  });

  it("tracks the hover slot as the pointer sweeps", () => {
    renderStrip();
    layOutTabs();
    const el = screen.getByTestId("tab-1");
    fireEvent.pointerDown(el, { pointerId: 6, clientX: 50, clientY: 10, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 6, clientX: 160, clientY: 10 }); // hover slot 2
    expect(indicator()!.style.left).toBe("200px");
    fireEvent.pointerMove(el, { pointerId: 6, clientX: 120, clientY: 10 }); // back to slot 1
    expect(indicator()!.style.left).toBe("100px");
    fireEvent.pointerUp(el, { pointerId: 6, clientX: 120, clientY: 10 });
  });

  it("paints the vertical rail's indicator on the Y axis and clears it on pointercancel", () => {
    renderStrip({ orientation: "vertical" });
    layOutTabsVertically();
    const el = screen.getByTestId("tab-1");
    fireEvent.pointerDown(el, { pointerId: 8, clientX: 90, clientY: 15, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 8, clientX: 90, clientY: 80 }); // hover slot 2
    const line = indicator();
    expect(line).not.toBeNull();
    expect(line!.className).toContain("tab-strip__indicator--vertical");
    expect(line!.style.top).toBe("60px"); // slot 2's boundary (rect.top), strip at y=0
    expect(line!.style.left).toBe(""); // the cross-axis stays CSS-owned
    fireEvent.pointerCancel(el, { pointerId: 8 });
    expect(indicator()).toBeNull(); // cancel clears too
  });

  it("never renders for a sub-slop click", () => {
    renderStrip();
    layOutTabs();
    const el = screen.getByTestId("tab-2");
    fireEvent.pointerDown(el, { pointerId: 3, clientX: 150, clientY: 10, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 3, clientX: 150 + DRAG_SLOP_PX - 1, clientY: 10 });
    expect(indicator()).toBeNull();
    fireEvent.pointerUp(el, { pointerId: 3, clientX: 150 + DRAG_SLOP_PX - 1, clientY: 10 });
    expect(indicator()).toBeNull();
  });
});

// trmx-75 (FR-2.4): the inline rename input. It replaces the renamed tab's label, seeds from the
// current title, commits on Enter/blur, cancels on Esc — and is EVENT-ISOLATED from the strip's
// activation/drag machinery (pointer + key events inside the input never reach the tab div).
describe("TabStrip rename (trmx-75)", () => {
  const input = () => screen.getByTestId("tab-rename-input") as HTMLInputElement;

  it("renders the input in place of the renamed tab's label, seeded + focused + select-all", () => {
    renderStrip({ renamingTabId: 2 });
    const el = input();
    expect(el.value).toBe("vim"); // seeded with the tab's CURRENT title
    // The label span is replaced (the other tabs keep theirs).
    expect(screen.getByTestId("tab-2").querySelector(".tab-strip__title")).toBeNull();
    expect(screen.getByTestId("tab-1").querySelector(".tab-strip__title")).not.toBeNull();
    // Autofocus + select-all: the first keystroke replaces the whole title.
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe("vim".length);
  });

  it("double-click on a tab label starts rename for THAT tab", () => {
    // The handler sits on the tab DIV (pointer capture retargets click/dblclick there in a real
    // browser); a dblclick on the label bubbles up to it.
    const { onRenameStart } = renderStrip();
    fireEvent.doubleClick(screen.getByTitle("build"));
    expect(onRenameStart).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("double-click on the close button does not start rename", () => {
    const { onRenameStart } = renderStrip();
    fireEvent.doubleClick(screen.getByTestId("tab-close-3"));
    expect(onRenameStart).not.toHaveBeenCalled();
  });

  it("Enter commits the edited value exactly once — a following blur must not double-commit", () => {
    const { onRenameCommit, onRenameCancel } = renderStrip({ renamingTabId: 2 });
    fireEvent.change(input(), { target: { value: "a b c" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onRenameCommit).toHaveBeenCalledExactlyOnceWith(2, "a b c");
    // In the app the input unmounts on commit; if a blur still lands, it must not re-commit.
    fireEvent.blur(input());
    expect(onRenameCommit).toHaveBeenCalledTimes(1);
    expect(onRenameCancel).not.toHaveBeenCalled();
  });

  it("blur commits the current value", () => {
    const { onRenameCommit } = renderStrip({ renamingTabId: 2 });
    fireEvent.change(input(), { target: { value: "deploy" } });
    fireEvent.blur(input());
    expect(onRenameCommit).toHaveBeenCalledExactlyOnceWith(2, "deploy");
  });

  it("Escape cancels without committing — even if a blur follows", () => {
    const { onRenameCommit, onRenameCancel } = renderStrip({ renamingTabId: 2 });
    fireEvent.change(input(), { target: { value: "nope" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onRenameCancel).toHaveBeenCalledTimes(1);
    expect(onRenameCommit).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(onRenameCommit).not.toHaveBeenCalled();
  });

  it("an emptied input commits the empty string (App turns it into clear-to-auto)", () => {
    const { onRenameCommit } = renderStrip({ renamingTabId: 2 });
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onRenameCommit).toHaveBeenCalledExactlyOnceWith(2, "");
  });

  it("typing lands verbatim — Space/Enter inside the input never reach the tab's key handlers", () => {
    const { onActivate, onRenameCommit } = renderStrip({ renamingTabId: 2 });
    // The tab div activates on Space/Enter keydown; from INSIDE the input those must only type
    // (Space) or commit (Enter) — stopPropagation is the event-isolation requirement.
    fireEvent.keyDown(input(), { key: "a" });
    fireEvent.keyDown(input(), { key: " " });
    fireEvent.keyDown(input(), { key: "b" });
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.change(input(), { target: { value: "a b c" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onRenameCommit).toHaveBeenCalledExactlyOnceWith(2, "a b c");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("pointer interactions inside the input neither activate nor drag the tab", () => {
    const { onActivate, onMove } = renderStrip({ renamingTabId: 2 });
    layOutTabs();
    const el = input();
    // A click inside the input (caret placement)…
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 150, clientY: 10, button: 0 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 150, clientY: 10 });
    fireEvent.click(el);
    // …and a text-selection drag well past the slop (would reorder if the strip saw it).
    fireEvent.pointerDown(el, { pointerId: 2, clientX: 110, clientY: 10, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 260, clientY: 10 });
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 260, clientY: 10 });
    expect(onActivate).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("double-click inside the input does not restart rename", () => {
    const { onRenameStart } = renderStrip({ renamingTabId: 2 });
    fireEvent.doubleClick(input());
    expect(onRenameStart).not.toHaveBeenCalled();
  });
});
