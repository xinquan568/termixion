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
  realAttachOscIntegrations,
  type AttachOscIntegrations,
  type ResizeObservation,
  type AttachScrollbar,
} from "./TerminalView";
import type { MountDeps, TerminalHandle } from "./mountTerminal";
import type { AttachScrollbarHandle } from "./scrollbar";
import { buildXtermTheme } from "../theme/buildXtermTheme";

// A no-op resize seam for tests that don't care about the resize path.
const noopObserve: ResizeObservation = () => () => {};

// A no-op scrollbar seam (trmx-41) for tests that don't exercise it; returns a disposable handle.
const noopScrollbarHandle: AttachScrollbarHandle = {
  recompute: () => {},
  dispose: () => {},
};
const noopAttachScrollbar: AttachScrollbar = () => noopScrollbarHandle;

// A no-op OSC-integrations seam (trmx-64) for tests that don't exercise it.
const noopAttachOsc: AttachOscIntegrations = () => () => {};

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
        attachOscIntegrations={noopAttachOsc}
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
        attachOscIntegrations={noopAttachOsc}
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
        attachOscIntegrations={noopAttachOsc}
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
        attachOscIntegrations={noopAttachOsc}
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
        attachOscIntegrations={noopAttachOsc}
      />,
    );

    fireResize?.();

    // fit must run before recompute, otherwise the scrollbar would read stale rows/cols.
    expect(calls).toEqual(["fit", "recompute"]);
  });

  it("re-themes the live terminal, syncs the backgrounds, and recomputes the scrollbar on a theme broadcast (trmx-53)", () => {
    // A terminal whose options.theme can be reassigned at runtime (xterm repaints on assignment).
    const terminal = { options: {} as { theme?: unknown } };
    const handle: TerminalHandle = {
      terminal: terminal as never,
      renderer: "webgl",
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );

    // Capture the settings callback so the test can drive a cross-window theme change (the
    // settings window writing appearance.theme, or a reset broadcast).
    let fireSettings: ((payload: unknown) => void) | undefined;
    const observeSettings = vi.fn((onChange: (payload: unknown) => void) => {
      fireSettings = onChange;
      return () => {};
    });

    // Spy the scrollbar so we can assert the theme switch recomputes it (its colors derive from
    // the theme's scrollbarSlider* tokens since trmx-53).
    const recompute = vi.fn();
    const attachScrollbar = vi.fn<AttachScrollbar>(() => ({
      recompute,
      dispose: vi.fn(),
    }));

    render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={attachScrollbar}
        observeSettings={observeSettings}
        attachOscIntegrations={noopAttachOsc}
      />,
    );

    expect(observeSettings).toHaveBeenCalledTimes(1);
    const host = mount.mock.calls[0][0];
    const body = host.ownerDocument.body;

    // The settings window picks Sepia → the terminal adopts it wholesale, without a remount.
    fireSettings?.({ key: "appearance.theme", value: "sepia", source: "settings" });
    expect(terminal.options.theme).toEqual(buildXtermTheme("sepia"));
    expect(mount).toHaveBeenCalledTimes(1);
    // The host AND body background are synced to the theme (no wrong-color inset margin), and
    // the scrollbar is recomputed. (Compare host===body + theme≠theme rather than a color
    // string, to stay robust to jsdom's hex/rgb serialization.)
    const sepiaBg = host.style.background;
    expect(sepiaBg).not.toBe("");
    expect(body.style.background).toBe(sepiaBg);
    expect(recompute).toHaveBeenCalledTimes(1);

    // …and to Night: theme + backgrounds update again, scrollbar recomputed again.
    fireSettings?.({ key: "appearance.theme", value: "night", source: "settings" });
    expect(terminal.options.theme).toEqual(buildXtermTheme("night"));
    const nightBg = host.style.background;
    expect(nightBg).not.toBe("");
    expect(nightBg).not.toBe(sepiaBg);
    expect(body.style.background).toBe(nightBg);
    expect(recompute).toHaveBeenCalledTimes(2);

    // Junk theme payloads are inert: no repaint, no recompute.
    fireSettings?.({ key: "appearance.theme", value: "neon", source: "settings" });
    expect(terminal.options.theme).toEqual(buildXtermTheme("night"));
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  it("applies settings:changed cursor broadcasts to the live terminal (trmx-51)", () => {
    const terminal = { options: {} as { cursorStyle?: string; cursorBlink?: boolean } };
    const handle: TerminalHandle = {
      terminal: terminal as never,
      renderer: "webgl",
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );

    // Capture the settings callback so the test can play the settings window's broadcasts.
    let fireSettings: ((payload: unknown) => void) | undefined;
    const observeSettings = vi.fn((onChange: (payload: unknown) => void) => {
      fireSettings = onChange;
      return () => {};
    });

    const attachScrollbar = vi.fn<AttachScrollbar>(() => ({
      recompute: vi.fn(),
      dispose: vi.fn(),
    }));
    render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={attachScrollbar}
        observeSettings={observeSettings}
        attachOscIntegrations={noopAttachOsc}
      />,
    );
    expect(observeSettings).toHaveBeenCalledTimes(1);

    // The settings window changes the cursor (user turns blink ON over the trmx-55 off default) —
    // the live terminal follows without a remount.
    fireSettings?.({ key: "terminal.cursorStyle", value: "bar", source: "settings" });
    fireSettings?.({ key: "terminal.cursorBlink", value: true, source: "settings" });
    expect(terminal.options.cursorStyle).toBe("bar");
    expect(terminal.options.cursorBlink).toBe(true);
    expect(mount).toHaveBeenCalledTimes(1);

    // Reset broadcasts the defaults — the live terminal reverts to underline + no blink (trmx-55).
    fireSettings?.({ key: "terminal.cursorStyle", value: "underline", source: "settings" });
    fireSettings?.({ key: "terminal.cursorBlink", value: false, source: "settings" });
    expect(terminal.options.cursorStyle).toBe("underline");
    expect(terminal.options.cursorBlink).toBe(false);

    // Junk and non-cursor payloads are inert.
    fireSettings?.({ key: "update.autoCheck", value: false });
    fireSettings?.("garbage");
    expect(terminal.options).toEqual({ cursorStyle: "underline", cursorBlink: false });
  });

  it("stops observing settings broadcasts on unmount (trmx-51/53: no leaked listener)", () => {
    const handle: TerminalHandle = {
      terminal: { options: {} } as never,
      renderer: "webgl",
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );

    const stopSettings = vi.fn();
    const observeSettings = vi.fn(() => stopSettings);

    const { unmount } = render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        observeSettings={observeSettings}
        attachOscIntegrations={noopAttachOsc}
      />,
    );

    expect(stopSettings).not.toHaveBeenCalled();
    unmount();
    expect(stopSettings).toHaveBeenCalledTimes(1);
  });

  it("attaches the OSC integrations to the mounted terminal and tears them down on unmount (trmx-64)", () => {
    const teardown = vi.fn();
    const handle: TerminalHandle = {
      terminal: { id: "real-terminal" } as never,
      renderer: "webgl",
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );
    const attachOsc = vi.fn<AttachOscIntegrations>(() => teardown);

    const { unmount } = render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        attachOscIntegrations={attachOsc}
      />,
    );

    expect(attachOsc).toHaveBeenCalledTimes(1);
    expect(attachOsc.mock.calls[0][0]).toBe(handle.terminal);

    unmount();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("realAttachOscIntegrations wires title/52/7 over one terminal and disposes all three (trmx-64)", () => {
    // A capable fake: the narrow slices the three modules need, with recording registrations.
    let titleHandler: ((t: string) => void) | undefined;
    const titleDispose = vi.fn();
    const oscRegistrations: Array<{ ident: number; dispose: ReturnType<typeof vi.fn> }> = [];
    const fakeTerminal = {
      onTitleChange: (h: (t: string) => void) => {
        titleHandler = h;
        return { dispose: titleDispose };
      },
      parser: {
        registerOscHandler: (ident: number) => {
          const dispose = vi.fn();
          oscRegistrations.push({ ident, dispose });
          return { dispose };
        },
      },
    };
    const setTitle = vi.fn();
    const writeClipboard = vi.fn();

    const teardown = realAttachOscIntegrations(fakeTerminal as never, {
      setTitle,
      writeClipboard,
    });

    // OSC 0/2 titles forward to the injected sink; 52 and 7 handlers are registered.
    titleHandler?.("hello from OSC 2");
    expect(setTitle).toHaveBeenCalledWith("hello from OSC 2");
    expect(oscRegistrations.map((r) => r.ident).sort((a, b) => a - b)).toEqual([7, 52]);

    // One teardown disposes all three subscriptions.
    teardown();
    expect(titleDispose).toHaveBeenCalledTimes(1);
    for (const r of oscRegistrations) expect(r.dispose).toHaveBeenCalledTimes(1);
  });
});
