// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-98 (FR-1.5): the find bar's local keyboard + search lifecycle. The load-bearing case is ⌘G
// advancing WHILE the input is focused (the global keymap can't — resolve() nulls editable targets).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { FindBar, type SearchController, type Schedule } from "./FindBar";
import type { SearchLike } from "../terminal/mountTerminal";

beforeEach(() => cleanup());

function fakeSearch() {
  let resultsCb: ((e: { resultIndex: number; resultCount: number }) => void) | undefined;
  const api = {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn((cb: (e: { resultIndex: number; resultCount: number }) => void) => {
      resultsCb = cb;
      return { dispose: vi.fn() };
    }),
  };
  return { api: api as unknown as SearchLike, spies: api, emitResults: (i: number, n: number) => resultsCb?.({ resultIndex: i, resultCount: n }) };
}

/** A schedule that queues callbacks; `flush()` runs (and clears) the pending ones. */
function fakeSchedule() {
  const pending: Array<{ fn: () => void; cancelled: boolean }> = [];
  const schedule: Schedule = (fn) => {
    const entry = { fn, cancelled: false };
    pending.push(entry);
    return () => (entry.cancelled = true);
  };
  return { schedule, flush: () => pending.splice(0).forEach((e) => !e.cancelled && e.fn()) };
}

const colors = { match: "#ff0", activeMatch: "#f80" };

function setup(overrides: Partial<Parameters<typeof FindBar>[0]> = {}) {
  const s = fakeSearch();
  const sched = fakeSchedule();
  const onClose = vi.fn();
  let controller: SearchController | null = null;
  const onRegister = vi.fn((c: SearchController | null) => (controller = c));
  const utils = render(
    <FindBar
      search={s.api}
      colors={colors}
      onClose={onClose}
      onRegister={onRegister}
      schedule={sched.schedule}
      {...overrides}
    />,
  );
  const input = screen.getByLabelText("Find") as HTMLInputElement;
  return { ...s, sched, onClose, onRegister, getController: () => controller, input, utils };
}

describe("FindBar — local keyboard (finding 1: the autofocused input skips the global keymap)", () => {
  it("⌘G advances while the input is focused", () => {
    const t = setup();
    fireEvent.change(t.input, { target: { value: "foo" } });
    fireEvent.keyDown(t.input, { key: "g", metaKey: true });
    expect(t.spies.findNext).toHaveBeenCalledWith("foo", expect.anything());
  });
  it("⇧⌘G goes to the previous match", () => {
    const t = setup();
    fireEvent.change(t.input, { target: { value: "foo" } });
    fireEvent.keyDown(t.input, { key: "G", metaKey: true, shiftKey: true });
    expect(t.spies.findPrevious).toHaveBeenCalled();
  });
  it("Enter = next, ⇧Enter = previous", () => {
    const t = setup();
    fireEvent.change(t.input, { target: { value: "foo" } });
    fireEvent.keyDown(t.input, { key: "Enter" });
    expect(t.spies.findNext).toHaveBeenCalled();
    fireEvent.keyDown(t.input, { key: "Enter", shiftKey: true });
    expect(t.spies.findPrevious).toHaveBeenCalled();
  });
  it("Esc closes the bar", () => {
    const t = setup();
    fireEvent.keyDown(t.input, { key: "Escape" });
    expect(t.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("FindBar — search lifecycle", () => {
  it("debounces a query change into a single findNext when the schedule flushes", () => {
    const t = setup();
    fireEvent.change(t.input, { target: { value: "a" } });
    fireEvent.change(t.input, { target: { value: "ab" } });
    expect(t.spies.findNext).not.toHaveBeenCalled(); // still pending
    t.sched.flush();
    expect(t.spies.findNext).toHaveBeenCalledTimes(1);
    expect(t.spies.findNext).toHaveBeenCalledWith("ab", expect.anything());
  });
  it("shows the live match count from onDidChangeResults", () => {
    const t = setup();
    fireEvent.change(t.input, { target: { value: "x" } });
    act(() => t.emitResults(2, 17));
    expect(screen.getByText("3/17")).toBeInTheDocument();
  });
  it("an empty query clears decorations and shows no count", () => {
    const t = setup();
    fireEvent.change(t.input, { target: { value: "x" } });
    fireEvent.change(t.input, { target: { value: "" } });
    t.sched.flush();
    expect(t.spies.clearDecorations).toHaveBeenCalled();
    expect(screen.queryByText(/\/\d/)).toBeNull();
  });
  it("⌘G cancels a pending debounce so findNext fires exactly once (finding 1: no double-advance)", () => {
    const t = setup();
    fireEvent.change(t.input, { target: { value: "foo" } }); // schedules a debounced search
    fireEvent.keyDown(t.input, { key: "g", metaKey: true }); // manual next — must cancel the pending run
    t.sched.flush(); // the cancelled debounce must NOT fire a second findNext
    expect(t.spies.findNext).toHaveBeenCalledTimes(1);
  });
  it("re-decorates in place when the theme colors change (finding 3)", () => {
    const t = setup();
    fireEvent.change(t.input, { target: { value: "foo" } });
    t.sched.flush();
    t.spies.clearDecorations.mockClear();
    t.spies.findNext.mockClear();
    t.utils.rerender(
      <FindBar
        search={t.api}
        colors={{ match: "#0f0", activeMatch: "#0a0" }}
        onClose={t.onClose}
        onRegister={t.onRegister}
        schedule={t.sched.schedule}
      />,
    );
    expect(t.spies.clearDecorations).toHaveBeenCalled(); // cleared + re-highlighted with the new tint
    expect(t.spies.findNext).toHaveBeenCalled();
  });
  it("an invalid regex sets the error state and does not search (no throw)", () => {
    const t = setup();
    fireEvent.click(screen.getByLabelText("Use regular expression")); // regex on
    fireEvent.change(t.input, { target: { value: "(" } }); // unbalanced
    t.sched.flush();
    expect(t.input).toHaveAttribute("aria-invalid", "true");
    expect(t.spies.findNext).not.toHaveBeenCalled();
    expect(t.spies.clearDecorations).toHaveBeenCalled();
  });
});

describe("FindBar — controller registration", () => {
  it("registers a controller on mount and deregisters on unmount", () => {
    const t = setup();
    expect(t.getController()).not.toBeNull();
    // The controller drives the SAME pane's search.
    fireEvent.change(t.input, { target: { value: "foo" } });
    t.getController()!.next();
    expect(t.spies.findNext).toHaveBeenCalledWith("foo", expect.anything());
    t.utils.unmount();
    expect(t.onRegister).toHaveBeenLastCalledWith(null);
  });
});
