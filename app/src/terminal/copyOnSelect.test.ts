// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-95 (FR-8, test-first): the auto-copy gesture machine. Copy on selection END (deferred
// pointerup), never on mid-drag ticks; empty never clobbers; dedup; keyboard debounce; a gesture that
// didn't change the selection copies nothing (no stale re-copy); cancel/blur aborts. Plus the ⌘C
// byte-equality anchor. Uses a controllable fake `schedule` — deterministic, no real timers.
//
// trmx-180 (reliability review, test-first): the dedup latch is BOUNDED — reset by a fresh gesture
// and expired by a time window — so re-selecting the same text after the pasteboard changed
// elsewhere always lands; the release event order {pointerup, lostpointercapture} is tolerated
// both ways (capture loss is a SOFT abort a same-turn release cancels); the deferred copy falls
// back to the release-time text when streaming reflow clears the selection in the gap. A fake
// `now` clock drives the dedup window.
import { describe, expect, it, vi } from "vitest";
import { attachCopyOnSelect, createCopyOnSelect, type Schedule } from "./copyOnSelect";
import { handleCopyEvent, selectionText, type ClipboardEventLike } from "./clipboard";

/** A schedule that runs the callback synchronously — for attach-level tests. */
const syncSchedule: Schedule = (fn) => {
  fn();
  return () => {};
};

function fakeSchedule() {
  const pending: Array<{ fn: () => void; cancelled: boolean }> = [];
  const schedule: Schedule = (fn) => {
    const entry = { fn, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    schedule,
    flush() {
      const toRun = pending.filter((e) => !e.cancelled);
      pending.length = 0;
      toRun.forEach((e) => e.fn());
    },
    pendingCount: () => pending.filter((e) => !e.cancelled).length,
  };
}

function harness(opts: { dedupWindowMs?: number } = {}) {
  let selection = "";
  let clock = 0; // trmx-180: fake time for the dedup window — no real timers
  const writeClipboard = vi.fn<(t: string) => void>();
  const sched = fakeSchedule();
  const machine = createCopyOnSelect({
    selectionText: () => selection,
    hasSelection: () => selection !== "",
    writeClipboard,
    schedule: sched.schedule,
    now: () => clock,
    dedupWindowMs: opts.dedupWindowMs,
  });
  return {
    machine,
    writeClipboard,
    flush: sched.flush,
    pendingCount: sched.pendingCount,
    setSelection: (s: string) => {
      selection = s;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createCopyOnSelect — mouse gesture", () => {
  it("copies ONCE on pointerup (deferred), never on mid-drag ticks", () => {
    const h = harness();
    h.machine.onPointerDown();
    h.setSelection("abc");
    h.machine.onSelectionChange(); // mid-drag tick
    h.machine.onSelectionChange(); // another tick
    expect(h.writeClipboard).not.toHaveBeenCalled(); // no mid-drag write
    h.machine.onPointerUp();
    expect(h.writeClipboard).not.toHaveBeenCalled(); // deferred, not synchronous
    h.flush();
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    expect(h.writeClipboard).toHaveBeenCalledWith("abc");
  });

  it("an empty/collapsed selection never writes (no clobber)", () => {
    const h = harness();
    h.machine.onPointerDown();
    h.setSelection(""); // a click that collapses / selects nothing
    h.machine.onSelectionChange();
    h.machine.onPointerUp();
    h.flush();
    expect(h.writeClipboard).not.toHaveBeenCalled();
  });

  it("a fresh gesture re-selecting the SAME text writes again — deliberate re-copy (trmx-180)", () => {
    const h = harness();
    const drag = (text: string) => {
      h.machine.onPointerDown();
      h.setSelection(text);
      h.machine.onSelectionChange();
      h.machine.onPointerUp();
      h.flush();
    };
    drag("abc");
    drag("abc"); // a NEW deliberate gesture over the same text — user intent, must land (D1.1)
    expect(h.writeClipboard).toHaveBeenCalledTimes(2);
    drag("def");
    expect(h.writeClipboard).toHaveBeenCalledTimes(3);
  });

  it("a trailing same-text keyboard tick right after a mouse copy stays deduped (trmx-95 anti-noise)", () => {
    const h = harness();
    h.machine.onPointerDown();
    h.setSelection("abc");
    h.machine.onSelectionChange();
    h.machine.onPointerUp();
    h.flush(); // the gesture copy
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    // xterm fires a late no-pointer tick for the same selection: within the dedup window → no rewrite.
    h.machine.onSelectionChange();
    h.flush(); // the debounced keyboard-path copy attempt
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
  });

  it("a gesture that did NOT change the selection copies nothing (no stale re-copy, finding 2)", () => {
    const h = harness();
    // First, copy a real selection.
    h.machine.onPointerDown();
    h.setSelection("abc");
    h.machine.onSelectionChange();
    h.machine.onPointerUp();
    h.flush();
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    // Now a click that leaves the PRE-EXISTING "abc" selection untouched (no onSelectionChange).
    h.machine.onPointerDown();
    h.machine.onPointerUp();
    h.flush();
    expect(h.writeClipboard).toHaveBeenCalledTimes(1); // no second write
  });

  it("a pointercancel / blur mid-drag aborts and does not stick (finding 1)", () => {
    const h = harness();
    h.machine.onPointerDown();
    h.setSelection("abc");
    h.machine.onSelectionChange();
    h.machine.onCancel(); // pointercancel / lostpointercapture / window blur
    h.flush();
    expect(h.writeClipboard).not.toHaveBeenCalled();
    // Not stuck "dragging": a fresh gesture still works.
    h.machine.onPointerDown();
    h.setSelection("def");
    h.machine.onSelectionChange();
    h.machine.onPointerUp();
    h.flush();
    expect(h.writeClipboard).toHaveBeenCalledWith("def");
  });

  it("reads the FINAL (settled) selection via the deferred copy — late word/line selection", () => {
    const h = harness();
    h.machine.onPointerDown();
    h.machine.onSelectionChange(); // dirty (selection began)
    h.machine.onPointerUp();
    h.setSelection("whole line"); // the final selection settles AFTER pointerup (double/triple-click)
    h.flush();
    expect(h.writeClipboard).toHaveBeenCalledWith("whole line");
  });
});

describe("createCopyOnSelect — keyboard/programmatic", () => {
  it("debounces a no-pointer selection change then copies once", () => {
    const h = harness();
    h.setSelection("all");
    h.machine.onSelectionChange(); // Select-All (no pointer down)
    h.machine.onSelectionChange(); // a second tick within the debounce
    expect(h.writeClipboard).not.toHaveBeenCalled();
    h.flush(); // the debounced copy fires
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    expect(h.writeClipboard).toHaveBeenCalledWith("all");
  });

  it("re-selecting the same text PAST the dedup window writes again (stale-latch fix, trmx-180)", () => {
    const h = harness();
    h.setSelection("all");
    h.machine.onSelectionChange();
    h.flush();
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    // The pasteboard may have changed elsewhere since; a later re-selection is fresh intent.
    h.advance(1500); // past the default 1000 ms window
    h.machine.onSelectionChange();
    h.flush();
    expect(h.writeClipboard).toHaveBeenCalledTimes(2);
  });

  it("a pointerdown supersedes a pending keyboard debounce (no ghost copy)", () => {
    const h = harness();
    h.setSelection("all");
    h.machine.onSelectionChange(); // debounce pending
    h.machine.onPointerDown(); // a fresh gesture supersedes it
    h.machine.onPointerUp(); // gesture changed nothing
    h.flush();
    expect(h.writeClipboard).not.toHaveBeenCalled();
  });
});

describe("createCopyOnSelect — capture-loss orderings (trmx-180)", () => {
  it("release order pointerup → captureLost copies once (the spec order)", () => {
    const h = harness();
    h.machine.onPointerDown();
    h.setSelection("abc");
    h.machine.onSelectionChange();
    h.machine.onPointerUp();
    h.machine.onCaptureLost(); // implicit capture release AFTER pointerup — must not kill the copy
    h.flush();
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    expect(h.writeClipboard).toHaveBeenCalledWith("abc");
  });

  it("release order captureLost → same-turn pointerup still copies (engine order variance)", () => {
    const h = harness();
    h.machine.onPointerDown();
    h.setSelection("abc");
    h.machine.onSelectionChange();
    h.machine.onCaptureLost(); // delivered FIRST on some engines
    h.machine.onPointerUp(); // same turn — the release wins over the soft abort
    h.flush();
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    expect(h.writeClipboard).toHaveBeenCalledWith("abc");
  });

  it("a genuine cancel (pointercancel-first) never copies; a stray pointerup stays inert", () => {
    const h = harness();
    h.machine.onPointerDown();
    h.setSelection("abc");
    h.machine.onSelectionChange();
    h.machine.onCancel(); // pointercancel — hard abort
    h.machine.onCaptureLost(); // the capture release that follows it
    h.machine.onPointerUp(); // stray — no matching down
    h.flush();
    expect(h.writeClipboard).not.toHaveBeenCalled();
  });

  it("a capture loss with NO release aborts (one tick later) and does not stick", () => {
    const h = harness();
    h.machine.onPointerDown();
    h.setSelection("abc");
    h.machine.onSelectionChange();
    h.machine.onCaptureLost(); // capture stolen mid-drag, no pointerup follows
    h.flush(); // the soft abort fires
    expect(h.writeClipboard).not.toHaveBeenCalled();
    // Not stuck "dragging": a fresh gesture still works.
    h.machine.onPointerDown();
    h.setSelection("def");
    h.machine.onSelectionChange();
    h.machine.onPointerUp();
    h.flush();
    expect(h.writeClipboard).toHaveBeenCalledWith("def");
  });
});

describe("createCopyOnSelect — release-time capture (trmx-180)", () => {
  it("selection cleared between pointerup and the deferred tick still copies the release-time text", () => {
    const h = harness();
    h.machine.onPointerDown();
    h.setSelection("abc");
    h.machine.onSelectionChange();
    h.machine.onPointerUp(); // captures "abc" at release
    h.setSelection(""); // streaming reflow clears the live selection in the gap
    h.flush();
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    expect(h.writeClipboard).toHaveBeenCalledWith("abc");
  });

  it("dispose with a deferred copy pending writes nothing", () => {
    const h = harness();
    h.machine.onPointerDown();
    h.setSelection("abc");
    h.machine.onSelectionChange();
    h.machine.onPointerUp(); // deferred copy pending
    h.machine.dispose();
    h.flush();
    expect(h.writeClipboard).not.toHaveBeenCalled();
  });
});

describe("attachCopyOnSelect — DOM wiring", () => {
  function domHarness(selectionValue: string) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let selCb: (() => void) | undefined;
    const terminal = {
      getSelection: () => selectionValue,
      hasSelection: () => selectionValue !== "",
      onSelectionChange: (cb: () => void) => {
        selCb = cb;
        return { dispose: () => {} };
      },
    };
    const writeClipboard = vi.fn<(t: string) => void>();
    return { host, terminal, writeClipboard, fireSelectionChange: () => selCb?.() };
  }

  it("falls back to document-level pointerup when setPointerCapture throws (release OUTSIDE the host)", () => {
    const h = domHarness("selected text");
    h.host.setPointerCapture = () => {
      throw new Error("capture unavailable");
    };
    const teardown = attachCopyOnSelect(h.host, h.terminal, h.writeClipboard, syncSchedule);

    h.host.dispatchEvent(new Event("pointerdown", { bubbles: true })); // capture throws → doc fallback armed
    h.fireSelectionChange(); // a drag tick marks the gesture dirty
    // Release OUTSIDE the host — dispatched on document, so ONLY the fallback can end the gesture.
    document.dispatchEvent(new Event("pointerup", { bubbles: true }));

    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    expect(h.writeClipboard).toHaveBeenCalledWith("selected text");
    teardown();
    h.host.remove();
  });

  it("does not double-copy on an in-host release, and teardown removes all listeners", () => {
    const h = domHarness("abc");
    h.host.setPointerCapture = () => {}; // capture succeeds → no doc fallback
    const teardown = attachCopyOnSelect(h.host, h.terminal, h.writeClipboard, syncSchedule);
    h.host.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    h.fireSelectionChange();
    h.host.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);

    teardown();
    // After teardown a new gesture is inert (listeners gone).
    h.host.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    h.host.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    h.host.remove();
  });

  it("a lostpointercapture after the in-host release never cancels the copy (trmx-180 contract)", () => {
    const h = domHarness("abc");
    h.host.setPointerCapture = () => {}; // capture succeeds
    const teardown = attachCopyOnSelect(h.host, h.terminal, h.writeClipboard, syncSchedule);
    h.host.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    h.fireSelectionChange();
    h.host.dispatchEvent(new Event("pointerup", { bubbles: true }));
    // The browser's implicit capture release — fired on EVERY captured release, after pointerup.
    h.host.dispatchEvent(new Event("lostpointercapture", { bubbles: true }));
    expect(h.writeClipboard).toHaveBeenCalledTimes(1);
    expect(h.writeClipboard).toHaveBeenCalledWith("abc");
    teardown();
    h.host.remove();
  });
});

describe("byte-equality anchor: auto-copy string == ⌘C string", () => {
  it("selectionText equals what handleCopyEvent writes, for a multi-line selection with trailing spaces", () => {
    const term = { hasSelection: () => true, getSelection: () => "line one   \nline two  " };
    let written = "";
    const ev: ClipboardEventLike = {
      clipboardData: { getData: () => "", setData: () => {} },
      preventDefault: () => {},
      stopPropagation: () => {},
    };
    // trmx-145: ⌘C writes through the injected native sink, not the event's setData.
    handleCopyEvent(ev, term, (text) => (written = text));
    expect(selectionText(term)).toBe(written); // auto-copy would write exactly the ⌘C bytes
  });
});
