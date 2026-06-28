// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-4 (test-first): the React wrapper mounts a terminal into its own DOM node on mount and tears it
// down on unmount. The mount strategy is injected, so this stays a real-DOM-but-no-xterm unit test.
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TerminalView } from "./TerminalView";
import type { MountDeps, TerminalHandle } from "./mountTerminal";

describe("TerminalView", () => {
  it("mounts into its container element and disposes on unmount", () => {
    const dispose = vi.fn();
    const handle: TerminalHandle = {
      terminal: {} as never,
      renderer: "webgl",
      dispose,
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );

    const { container, unmount } = render(<TerminalView mount={mount} />);

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
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );
    const onReady = vi.fn();

    render(<TerminalView mount={mount} onReady={onReady} />);

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(handle);
  });
});
