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
import { TabStrip, hoverIndexFromPoint, DRAG_SLOP_PX } from "./TabStrip";
import type { Tab } from "./tabState";

function tab(tabId: number, title: string): Tab {
  return { tabId, title, pane: { sessionId: null } };
}

function renderStrip(overrides: Partial<Parameters<typeof TabStrip>[0]> = {}) {
  const props = {
    tabs: [tab(1, "Shell"), tab(2, "vim"), tab(3, "build")],
    activeTabId: 2,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    onMove: vi.fn(),
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
