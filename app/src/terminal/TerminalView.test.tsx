// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-4 (test-first): the React wrapper mounts a terminal into its own DOM node on mount and tears it
// down on unmount. The mount strategy and the resize-observation seam are injected, so this stays a
// real-DOM-but-no-xterm unit test (jsdom has no ResizeObserver).
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import {
  TerminalView,
  type ResizeObservation,
  type AttachScrollbar,
} from "./TerminalView";
import type { MountDeps, TerminalHandle } from "./mountTerminal";
import type { AttachScrollbarHandle } from "./scrollbar";

// A no-op resize seam for tests that don't care about the resize path.
const noopObserve: ResizeObservation = () => () => {};

// A no-op scrollbar seam (trmx-41) for tests that don't exercise it; returns a disposable handle.
const noopScrollbarHandle: AttachScrollbarHandle = {
  recompute: () => {},
  dispose: () => {},
};
const noopAttachScrollbar: AttachScrollbar = () => noopScrollbarHandle;

describe("TerminalView", () => {
  it("mounts into its container element and disposes on unmount", () => {
    const dispose = vi.fn();
    const handle: TerminalHandle = {
      terminal: {} as never,
      renderer: "webgl",
      fit: vi.fn(),
      dispose,
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );

    const { container, unmount } = render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
      />,
    );

    expect(mount).toHaveBeenCalledTimes(1);
    const mountedInto = mount.mock.calls[0][0];
    expect(mountedInto).toBeInstanceOf(HTMLElement);
    // It mounts into a node that is actually in the rendered tree.
    expect(container.contains(mountedInto)).toBe(true);

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("calls onReady with the mounted handle so the parent can attach a PTY (C-2)", () => {
    const handle: TerminalHandle = {
      terminal: {} as never,
      renderer: "dom",
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );
    const onReady = vi.fn();

    render(
      <TerminalView
        mount={mount}
        onReady={onReady}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
      />,
    );

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(handle);
  });

  it("re-fits the terminal on resize and stops observing on unmount (issue 2: responsive content)", () => {
    const fit = vi.fn();
    const handle: TerminalHandle = {
      terminal: {} as never,
      renderer: "webgl",
      fit,
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );

    // Capture the resize callback so the test can fire a synthetic resize; spy the disconnect.
    let fireResize: (() => void) | undefined;
    const disconnect = vi.fn();
    const observeResize = vi.fn<ResizeObservation>((_target, onResize) => {
      fireResize = onResize;
      return disconnect;
    });

    const { unmount } = render(
      <TerminalView
        mount={mount}
        observeResize={observeResize}
        attachScrollbar={noopAttachScrollbar}
      />,
    );

    // The component observes the very element it mounted the terminal into.
    expect(observeResize).toHaveBeenCalledTimes(1);
    expect(observeResize.mock.calls[0][0]).toBe(mount.mock.calls[0][0]);

    // A resize re-fits the grid so the content scales with the window.
    expect(fit).not.toHaveBeenCalled();
    fireResize?.();
    expect(fit).toHaveBeenCalledTimes(1);

    // Teardown stops observing.
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("attaches the scrollbar to the host + terminal and disposes it on unmount (trmx-41)", () => {
    const dispose = vi.fn();
    const handle: TerminalHandle = {
      terminal: { id: "real-terminal" } as never,
      renderer: "webgl",
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );
    const attachScrollbar = vi.fn<AttachScrollbar>(() => ({
      recompute: vi.fn(),
      dispose,
    }));

    const { unmount } = render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={attachScrollbar}
      />,
    );

    // It attaches to the same host it mounted into, with the mounted terminal.
    expect(attachScrollbar).toHaveBeenCalledTimes(1);
    expect(attachScrollbar.mock.calls[0][0]).toBe(mount.mock.calls[0][0]);
    expect(attachScrollbar.mock.calls[0][1]).toBe(handle.terminal);

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("recomputes the scrollbar AFTER re-fitting on resize, so it reads fresh rows/cols (trmx-41)", () => {
    const calls: string[] = [];
    const fit = vi.fn(() => calls.push("fit"));
    const handle: TerminalHandle = {
      terminal: {} as never,
      renderer: "webgl",
      fit,
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );

    let fireResize: (() => void) | undefined;
    const observeResize = vi.fn<ResizeObservation>((_target, onResize) => {
      fireResize = onResize;
      return () => {};
    });

    const recompute = vi.fn(() => calls.push("recompute"));
    const attachScrollbar = vi.fn<AttachScrollbar>(() => ({
      recompute,
      dispose: vi.fn(),
    }));

    render(
      <TerminalView
        mount={mount}
        observeResize={observeResize}
        attachScrollbar={attachScrollbar}
      />,
    );

    fireResize?.();

    // fit must run before recompute, otherwise the scrollbar would read stale rows/cols.
    expect(calls).toEqual(["fit", "recompute"]);
  });
});
