// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-188 (test-first): the app-drawn main-window title bar. Under TitleBarStyle::Overlay the
// native chrome is gone — the webview draws the bar: a full-width drag strip whose LEFT is the
// active tab's derived title (consumed, never re-derived — tabTitle.ts owns the ladder) and whose
// RIGHT is a priority slot that content (trmx-190's counters) mounts into. The layout contract
// (ellipsis, slot-never-covered) is CSS and lives in the Playwright tier; THIS suite pins the
// headless component contract: title consumption, slot presence, drag-region attribute placement
// (Tauri's drag handler only fires on elements that carry the attribute — children must repeat
// it; the slot must NOT, it will hold interactive content), and the fullscreen inset collapse
// driven through the injected observeFullscreen seam (the real impl needs a Tauri runtime).
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { TitleBar } from "./TitleBar";

const DRAG_ATTR = "data-tauri-drag-region";

function parts(container: HTMLElement) {
  const bar = container.querySelector(".title-bar") as HTMLElement;
  return {
    bar,
    inset: bar.querySelector(".title-bar__inset") as HTMLElement,
    title: bar.querySelector(".title-bar__title") as HTMLElement,
    slot: bar.querySelector(".title-bar__slot") as HTMLElement,
  };
}

describe("TitleBar (trmx-188)", () => {
  it("renders the given title in the truncating span", () => {
    const { container } = render(<TitleBar title="vim — notes.md" />);
    const { title } = parts(container);
    expect(title.textContent).toBe("vim — notes.md");
  });

  it("renders the right slot element even when empty, and mounts rightSlot content into it", () => {
    const empty = render(<TitleBar title="zsh" />);
    expect(parts(empty.container).slot).not.toBeNull();
    expect(parts(empty.container).slot.textContent).toBe("");

    const filled = render(
      <TitleBar title="zsh" rightSlot={<span data-testid="counters">3 live</span>} />,
    );
    const slot = parts(filled.container).slot;
    expect(slot.querySelector('[data-testid="counters"]')?.textContent).toBe("3 live");
  });

  it("carries the drag-region attribute on the bar, inset, and title — never the slot", () => {
    const { container } = render(<TitleBar title="zsh" />);
    const { bar, inset, title, slot } = parts(container);
    expect(bar.hasAttribute(DRAG_ATTR)).toBe(true);
    expect(inset.hasAttribute(DRAG_ATTR)).toBe(true);
    expect(title.hasAttribute(DRAG_ATTR)).toBe(true);
    expect(slot.hasAttribute(DRAG_ATTR)).toBe(false);
  });

  it("collapses the traffic-light inset while fullscreen (observeFullscreen seam)", () => {
    let notify: ((fullscreen: boolean) => void) | undefined;
    const observeFullscreen = (onChange: (fullscreen: boolean) => void) => {
      notify = onChange;
      return () => {};
    };
    const { container } = render(<TitleBar title="zsh" observeFullscreen={observeFullscreen} />);
    const { bar } = parts(container);
    expect(bar.className).not.toContain("title-bar--fullscreen");

    act(() => notify?.(true));
    expect(bar.className).toContain("title-bar--fullscreen");

    act(() => notify?.(false));
    expect(bar.className).not.toContain("title-bar--fullscreen");
  });

  it("disposes the fullscreen subscription on unmount", () => {
    const dispose = vi.fn();
    const observeFullscreen = vi.fn().mockReturnValue(dispose);
    const { unmount } = render(<TitleBar title="zsh" observeFullscreen={observeFullscreen} />);
    expect(observeFullscreen).toHaveBeenCalledTimes(1);
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
