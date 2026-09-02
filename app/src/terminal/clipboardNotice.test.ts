// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-252 (test 12): the per-pane OSC 52 clipboard notice. Two properties matter beyond "it
// shows": (1) a program that yanks in a loop must not stack notices — repeated requests COALESCE
// behind ONE timer; (2) that timer must be cleared on teardown, or a fired callback touches a
// host belonging to a disposed pane. The timer seam is injected so neither is asserted by waiting.
import { describe, expect, it, vi } from "vitest";
import {
  attachClipboardNotice,
  CLIPBOARD_NOTICE_TEXT,
  type ClipboardNoticeTimers,
} from "./clipboardNotice";

/** A manual timer seam: nothing fires until the test says so. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  const timers: ClipboardNoticeTimers = {
    setTimeout: (fn: () => void) => {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => {
      pending.delete(id);
    },
  };
  return {
    timers,
    setSpy: vi.spyOn(timers, "setTimeout"),
    clearSpy: vi.spyOn(timers, "clearTimeout"),
    /** Fire a scheduled callback by id, whether or not it is still registered (post-teardown case). */
    fire(id: number) {
      pending.get(id)?.();
    },
    /** Fire every still-pending callback. */
    fireAll() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    pendingCount: () => pending.size,
  };
}

function makeHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

function notices(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-testid='clipboard-notice']")];
}

describe("attachClipboardNotice (trmx-252)", () => {
  it("shows ONE notice for the first accepted request", () => {
    const host = makeHost();
    const t = fakeTimers();
    const notice = attachClipboardNotice(host, { timers: t.timers, document });
    expect(notices(host)).toHaveLength(0); // nothing until a program actually asks

    notice.notify();
    const shown = notices(host);
    expect(shown).toHaveLength(1);
    expect(shown[0].textContent).toBe(CLIPBOARD_NOTICE_TEXT);
    notice.dispose();
  });

  it("claims only an ACCEPTED REQUEST — never a confirmed clipboard change", () => {
    // The native write goes over IPC and swallows async failure (nativeClipboard.ts), so wording
    // like "clipboard set"/"copied" would assert something this code cannot observe.
    expect(CLIPBOARD_NOTICE_TEXT.toLowerCase()).toContain("request");
    for (const forbidden of ["copied", "clipboard set", "clipboard updated"]) {
      expect(CLIPBOARD_NOTICE_TEXT.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("is visually distinct from the pane badge and the activity line", () => {
    const host = makeHost();
    const t = fakeTimers();
    const notice = attachClipboardNotice(host, { timers: t.timers, document });
    notice.notify();
    const el = notices(host)[0];
    expect(el.className).toContain("tx-clipboard-notice");
    expect(el.className).not.toContain("tx-badge");
    expect(el.className).not.toContain("tx-activity-line");
    // Click-through, like the other pane overlays (jsdom runs css:false, so assert it inline).
    expect(el.style.pointerEvents).toBe("none");
    notice.dispose();
  });

  it("COALESCES repeated requests: one notice, one timer", () => {
    const host = makeHost();
    const t = fakeTimers();
    const notice = attachClipboardNotice(host, { timers: t.timers, document });

    notice.notify();
    notice.notify();
    notice.notify();

    expect(notices(host)).toHaveLength(1);
    expect(t.setSpy).toHaveBeenCalledTimes(1);
    expect(t.pendingCount()).toBe(1);
    notice.dispose();
  });

  it("clears itself when the timer fires, and a later request opens a fresh notice", () => {
    const host = makeHost();
    const t = fakeTimers();
    const notice = attachClipboardNotice(host, { timers: t.timers, document });

    notice.notify();
    t.fireAll();
    expect(notices(host)).toHaveLength(0);

    notice.notify();
    expect(notices(host)).toHaveLength(1);
    expect(t.setSpy).toHaveBeenCalledTimes(2); // a second window, not a leaked first one
    notice.dispose();
  });

  it("dispose() clears the pending timer and removes the notice", () => {
    const host = makeHost();
    const t = fakeTimers();
    const notice = attachClipboardNotice(host, { timers: t.timers, document });

    notice.notify();
    const timerId = t.setSpy.mock.results[0].value as number;
    notice.dispose();

    expect(t.clearSpy).toHaveBeenCalledWith(timerId);
    expect(t.pendingCount()).toBe(0);
    expect(notices(host)).toHaveLength(0);
  });

  it("a timer that fires AFTER dispose is inert (no resurrection of a disposed pane's notice)", () => {
    const host = makeHost();
    const t = fakeTimers();
    const notice = attachClipboardNotice(host, { timers: t.timers, document });

    notice.notify();
    const captured = t.setSpy.mock.calls[0][0] as () => void;
    notice.dispose();
    expect(() => captured()).not.toThrow();
    expect(notices(host)).toHaveLength(0);
  });

  it("notify() after dispose does nothing (no node, no timer)", () => {
    const host = makeHost();
    const t = fakeTimers();
    const notice = attachClipboardNotice(host, { timers: t.timers, document });
    notice.dispose();
    t.setSpy.mockClear();

    notice.notify();
    expect(notices(host)).toHaveLength(0);
    expect(t.setSpy).not.toHaveBeenCalled();
  });
});
