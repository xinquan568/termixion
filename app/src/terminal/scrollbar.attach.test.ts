// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-41 (test-first): the `attachScrollbar` wiring over a small terminal interface. We drive a fake
// terminal (no real xterm) and assert that scroll / buffer-change events recompute the overlay, that the
// overlay appears only while scrolled back, and that dispose() unsubscribes and removes the element.
import { describe, it, expect, vi } from "vitest";
import { attachScrollbar, type ScrollbarTerminalLike } from "./scrollbar";

// A mutable fake of the xterm slice attachScrollbar consumes; the test mutates the buffer then fires the
// captured listener, exactly as xterm would on a real scroll / buffer switch.
function makeFakeTerminal() {
  const active = {
    viewportY: 100,
    baseY: 100, // start pinned to the live bottom → no scrollbar
    length: 124,
    type: "normal" as "normal" | "alternate",
  };
  let scrollHandler: (() => void) | undefined;
  let bufferHandler: (() => void) | undefined;
  // Dispose also unregisters the handler — xterm's IDisposable contract — so a test can prove a
  // post-dispose event fire is truly inert (attachScrollbar really tore its subscription down).
  const scrollDispose = vi.fn(() => {
    scrollHandler = undefined;
  });
  const bufferDispose = vi.fn(() => {
    bufferHandler = undefined;
  });

  const terminal: ScrollbarTerminalLike = {
    rows: 24,
    cols: 80,
    options: { theme: { foreground: "#ffffff" } },
    onScroll: (h: () => void) => {
      scrollHandler = h;
      return { dispose: scrollDispose };
    },
    buffer: {
      active,
      onBufferChange: (h: () => void) => {
        bufferHandler = h;
        return { dispose: bufferDispose };
      },
    },
  };

  return {
    terminal,
    active,
    scrollDispose,
    bufferDispose,
    fireScroll: () => scrollHandler?.(),
    fireBufferChange: () => bufferHandler?.(),
  };
}

// jsdom has no layout, so give the host a non-zero measured size + a known rect for the geometry +
// hover hit-test math (rect.left = 0, so clientX runs 0..width across the host).
function makeHost(width = 800, height = 480) {
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: height, configurable: true });
  host.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(host);
  return host;
}

// Dispatch a mousemove at an absolute x within the host (rect.left = 0, so clientX is the host-local x).
function moveTo(host: HTMLElement, clientX: number) {
  host.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY: 200, bubbles: true }));
}

describe("attachScrollbar", () => {
  it("mounts a hidden overlay into the host (pinned to the bottom = nothing to show)", () => {
    const host = makeHost();
    const { terminal } = makeFakeTerminal();

    const sb = attachScrollbar(host, terminal);

    const container = host.querySelector(".termixion-scrollbar") as HTMLElement;
    expect(container).not.toBeNull();
    expect(container.style.display).toBe("none");
    sb.dispose();
  });

  it("shows the overlay on scroll-back and re-hides it back at the bottom", () => {
    const host = makeHost();
    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    const container = host.querySelector(".termixion-scrollbar") as HTMLElement;
    const thumb = host.querySelector(".termixion-scrollbar__thumb") as HTMLElement;

    // Scroll back: viewportY < baseY → the bar appears with a positioned thumb.
    fake.active.viewportY = 40;
    fake.fireScroll();
    expect(container.style.display).toBe("");
    expect(thumb.style.height).not.toBe("");

    // Back to the live bottom → hidden again.
    fake.active.viewportY = 100;
    fake.fireScroll();
    expect(container.style.display).toBe("none");

    sb.dispose();
  });

  it("paints the thumb from the theme's scrollbar tokens when present (trmx-53), foreground otherwise", () => {
    const host = makeHost();
    const fake = makeFakeTerminal();
    // A themed terminal (buildXtermTheme output shape): the slider tokens carry their own alpha.
    fake.terminal.options.theme = {
      foreground: "#d6d9de",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.12)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.20)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.30)",
    };
    const sb = attachScrollbar(host, fake.terminal);
    const thumb = host.querySelector(".termixion-scrollbar__thumb") as HTMLElement;

    fake.active.viewportY = 40;
    fake.fireScroll();
    expect(thumb.style.background).toBe("rgba(255, 255, 255, 0.12)");
    expect(thumb.style.opacity).toBe("1");

    // A live theme swap is picked up on the next recompute (TerminalView calls recompute()).
    fake.terminal.options.theme = { foreground: "#abcdef" };
    sb.recompute();
    expect(thumb.style.background).toBe("rgb(171, 205, 239)");
    expect(thumb.style.opacity).toBe("0.5"); // trmx-41 Kitty handle opacity fallback

    sb.dispose();
  });

  it("recomputes on a native viewport scroll (the wheel path that does NOT fire terminal.onScroll)", () => {
    // Reproduces trmx-41: xterm SUPPRESSES its public `onScroll` for user-initiated viewport scrolling —
    // the Viewport requests its scrollLines with suppressScrollEvent=true, so a wheel / trackpad /
    // keyboard scroll-back never fires `onScroll`. The overlay must therefore also react to the
    // `.xterm-viewport` element's native `scroll` event, or it stays hidden the whole time the user
    // scrolls back through the scrollback.
    const host = makeHost();
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    host.appendChild(viewport);

    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    const container = host.querySelector(".termixion-scrollbar") as HTMLElement;
    const thumb = host.querySelector(".termixion-scrollbar__thumb") as HTMLElement;

    // The user wheels back: xterm has updated the buffer's viewportY but fires NO onScroll. We
    // deliberately do NOT call fake.fireScroll() — only the native viewport scroll event is dispatched.
    fake.active.viewportY = 40;
    viewport.dispatchEvent(new Event("scroll"));

    expect(container.style.display).toBe("");
    expect(thumb.style.height).not.toBe("");

    // Back to the live bottom, again via the native scroll event only → hidden.
    fake.active.viewportY = 100;
    viewport.dispatchEvent(new Event("scroll"));
    expect(container.style.display).toBe("none");

    sb.dispose();
  });

  it("tracks an ANIMATED scroll: a burst of native viewport events recomputes the thumb every frame (trmx-65)", () => {
    // With smoothScrollDuration set (trmx-65), a discrete wheel step / Shift+PageUp animates: xterm
    // emits a burst of native `.xterm-viewport` scroll events (still no public onScroll) as the
    // animation interpolates viewportY. The overlay must re-derive geometry on every frame of the
    // burst — a stale thumb mid-animation reads as lag.
    const host = makeHost();
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    host.appendChild(viewport);

    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    const thumb = host.querySelector(".termixion-scrollbar__thumb") as HTMLElement;

    const tops: number[] = [];
    for (const frameViewportY of [80, 60, 40, 20]) {
      fake.active.viewportY = frameViewportY;
      viewport.dispatchEvent(new Event("scroll"));
      tops.push(parseFloat(thumb.style.top));
    }
    // Every frame recomputed: four distinct, strictly decreasing thumb positions (scrolling back
    // moves the thumb up toward the older content).
    expect(new Set(tops).size).toBe(4);
    for (let i = 1; i < tops.length; i++) expect(tops[i]).toBeLessThan(tops[i - 1]);

    sb.dispose();
  });

  it("removes the viewport scroll listener on dispose (no leaked recompute on the detached overlay)", () => {
    const host = makeHost();
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    host.appendChild(viewport);

    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    const container = host.querySelector(".termixion-scrollbar") as HTMLElement;

    sb.dispose();
    expect(host.querySelector(".termixion-scrollbar")).toBeNull();

    // A post-dispose viewport scroll inside the scroll-back range must NOT run a recompute: if the
    // listener leaked, recompute would un-hide the (now-detached) container. Asserting it stays "none"
    // proves the listener was removed.
    fake.active.viewportY = 40;
    expect(() => viewport.dispatchEvent(new Event("scroll"))).not.toThrow();
    expect(container.style.display).toBe("none");
  });

  it("recomputes on a buffer change (alt-screen hides the bar even without a scroll event)", () => {
    const host = makeHost();
    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    const container = host.querySelector(".termixion-scrollbar") as HTMLElement;

    fake.active.viewportY = 40; // scrolled back in the normal buffer
    fake.fireScroll();
    expect(container.style.display).toBe("");

    // A full-screen app switches to the alternate buffer (no onScroll fired) → must hide on bufferChange.
    fake.active.type = "alternate";
    fake.fireBufferChange();
    expect(container.style.display).toBe("none");

    sb.dispose();
  });

  it("restores the bar after an alt-screen round-trip (trmx-64 pin of the trmx-41 × alt-screen interplay)", () => {
    const host = makeHost();
    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    const container = host.querySelector(".termixion-scrollbar") as HTMLElement;
    const thumb = host.querySelector(".termixion-scrollbar__thumb") as HTMLElement;

    // Start scrolled back in the normal buffer → visible (the baseline pinned by "shows the overlay on
    // scroll-back…"; re-established here only as the round-trip's starting state).
    fake.active.viewportY = 40;
    fake.fireScroll();
    expect(container.style.display).toBe("");
    const thumbTopBefore = thumb.style.top;
    const thumbHeightBefore = thumb.style.height;

    // DECSET 1049: a full-screen app enters the alternate screen. Real xterm swaps `buffer.active` to
    // the alt buffer; the fake keeps baseY at 100 (> 0) so this pins that the *type* check alone hides
    // the bar (Kitty's `has_scrollbar` requires the main line buffer), not merely a zeroed baseY.
    fake.active.type = "alternate";
    fake.fireBufferChange();
    expect(container.style.display).toBe("none");

    // DECRST 1049: the app exits and xterm reactivates the SAME normal buffer with its scroll state
    // intact — viewportY/baseY were never touched — firing only a buffer change, not a scroll. The bar
    // must come back on its own.
    fake.active.type = "normal";
    fake.fireBufferChange();
    expect(container.style.display).toBe("");
    // Identical restored buffer state ⇒ identical geometry: the thumb is exactly where it was.
    expect(thumb.style.top).toBe(thumbTopBefore);
    expect(thumb.style.height).toBe(thumbHeightBefore);

    // Back at the live bottom on the restored normal buffer → hidden again (Kitty `scrolled` policy).
    fake.active.viewportY = 100;
    fake.fireScroll();
    expect(container.style.display).toBe("none");

    sb.dispose();
  });

  it("widens the handle and fades in the track inside the right-edge hover zone, reverting on leave", () => {
    const host = makeHost(800, 480); // cellWidth = 800 / 80 cols = 10px
    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    const thumb = host.querySelector(".termixion-scrollbar__thumb") as HTMLElement;
    const track = host.querySelector(".termixion-scrollbar__track") as HTMLElement;

    // Scroll back so the bar is shown; at rest the handle is 0.5 cell wide and the track is invisible.
    fake.active.viewportY = 40;
    fake.fireScroll();
    expect(thumb.style.width).toBe("5px");
    expect(track.style.opacity).toBe("0");

    // Pointer within (hoverWidth 1.0 + gap 0.1) × 10px = 11px of the right edge → hover.
    moveTo(host, 795);
    expect(thumb.style.width).toBe("10px"); // widened to 1.0 cell
    expect(track.style.opacity).toBe("0.1"); // faint track fades in

    // Pointer far from the right edge → not hovering.
    moveTo(host, 400);
    expect(thumb.style.width).toBe("5px");
    expect(track.style.opacity).toBe("0");

    // Re-enter, then leave the host entirely → reverts.
    moveTo(host, 795);
    expect(thumb.style.width).toBe("10px");
    host.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(thumb.style.width).toBe("5px");
    expect(track.style.opacity).toBe("0");

    sb.dispose();
  });

  it("removes the host mouse listener on dispose (no leaked listener mutates the detached overlay)", () => {
    const host = makeHost(800, 480); // cellWidth = 10px
    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    const thumb = host.querySelector(".termixion-scrollbar__thumb") as HTMLElement;

    // Show the bar; at rest (not hovering) the handle is 0.5 cell = 5px wide.
    fake.active.viewportY = 40;
    fake.fireScroll();
    expect(thumb.style.width).toBe("5px");

    sb.dispose();
    expect(host.querySelector(".termixion-scrollbar")).toBeNull();

    // A post-dispose mousemove inside the hover zone must NOT run a recompute: if the listener leaked it
    // would widen the (still-referenced, now-detached) thumb to 10px. Asserting it stays 5px proves the
    // listener was actually removed, not merely that the container was detached.
    expect(() => moveTo(host, 795)).not.toThrow();
    expect(thumb.style.width).toBe("5px");
    expect(host.querySelector(".termixion-scrollbar")).toBeNull();
  });

  it("dispose() unsubscribes both listeners and removes the overlay", () => {
    const host = makeHost();
    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    expect(host.querySelector(".termixion-scrollbar")).not.toBeNull();

    sb.dispose();

    expect(fake.scrollDispose).toHaveBeenCalledTimes(1);
    expect(fake.bufferDispose).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".termixion-scrollbar")).toBeNull();
  });

  it("dispose() stays clean after alt-screen flips (no re-subscription accumulates across buffer changes)", () => {
    // trmx-64 pin: buffer flips route through the ONE subscription pair made at attach time —
    // attachScrollbar must not re-subscribe per buffer change — and dispose after a round-trip still
    // tears everything down exactly once.
    const host = makeHost();
    const fake = makeFakeTerminal();
    const sb = attachScrollbar(host, fake.terminal);
    const container = host.querySelector(".termixion-scrollbar") as HTMLElement;

    // A full normal → alternate → normal round-trip before disposing.
    fake.active.viewportY = 40;
    fake.fireScroll();
    fake.active.type = "alternate";
    fake.fireBufferChange();
    fake.active.type = "normal";
    fake.fireBufferChange();
    expect(container.style.display).toBe("");

    sb.dispose();

    // Exactly one subscription pair existed to tear down, and the overlay left the host.
    expect(fake.scrollDispose).toHaveBeenCalledTimes(1);
    expect(fake.bufferDispose).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".termixion-scrollbar")).toBeNull();

    // The fake's dispose unregisters its handler (xterm's IDisposable contract), so a post-dispose
    // buffer flip must be inert: a leaked subscription would recompute and flip the detached
    // container to "none" (alternate ⇒ hidden). It staying "" proves nothing ran.
    fake.active.type = "alternate";
    expect(() => fake.fireBufferChange()).not.toThrow();
    expect(container.style.display).toBe("");
  });
});
