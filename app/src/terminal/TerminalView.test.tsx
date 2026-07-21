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
  type AttachClipboard,
  type AttachCopyOnSelect,
  type ResizeObservation,
  type AttachScrollbar,
} from "./TerminalView";
import type { MountDeps, TerminalHandle } from "./mountTerminal";
import type { AttachScrollbarHandle } from "./scrollbar";
import { buildXtermTheme } from "../theme/buildXtermTheme";
import { currentCwd, makeCwdStore } from "./osc7";
import { __resetSettingsForTest, makeSettingsStore } from "../settings/settingsStore";

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

// A no-op clipboard seam (trmx-66) for tests that don't exercise it.
const noopAttachClipboard: AttachClipboard = () => () => {};

// A no-op auto-copy-on-select seam (trmx-95) for tests that don't exercise it (the real one calls
// terminal.onSelectionChange, absent on the fake `{}` terminals these tests mount).
const noopAttachCopyOnSelect: AttachCopyOnSelect = () => () => {};

// trmx-67: resize fits are coalesced onto animation frames. Tests that just want "a resize fits"
// inject an immediate frame (fire the callback now; cancel is a no-op) so firing the captured
// resize callback still fits synchronously — deterministic, no rAF in the loop.
const immediateFrame = (cb: () => void) => {
  cb();
  return () => {};
};

// trmx-67: jsdom measures every element 0×0 — exactly the hidden-window shape the coalesced fit
// skips. Tests that expect a fit give the host real area; the zero-area test leaves it unmeasured.
function giveHostArea(host: HTMLElement) {
  Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 600, configurable: true });
}

describe("TerminalView", () => {
  it("mounts into its container element and disposes on unmount", () => {
    const dispose = vi.fn();
    const handle: TerminalHandle = {
      terminal: {} as never,
      renderer: "webgl", search: {} as never,
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
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
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

  // trmx-95 (FR-8): auto-copy-on-select is attached per pane, gated by terminal.copyOnSelect (default
  // on) and live-toggled via settings:changed.
  it("attaches auto-copy-on-select when the setting is on (default) and detaches on unmount", () => {
    __resetSettingsForTest();
    const handle: TerminalHandle = { terminal: {} as never, renderer: "webgl", search: {} as never, fit: vi.fn(), dispose: vi.fn() };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(() => handle);
    const detach = vi.fn();
    const attachCopyOnSelect = vi.fn<AttachCopyOnSelect>(() => detach);

    const { unmount } = render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        attachOscIntegrations={noopAttachOsc}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={attachCopyOnSelect}
      />,
    );
    expect(attachCopyOnSelect).toHaveBeenCalledTimes(1);
    expect(attachCopyOnSelect.mock.calls[0][0]).toBe(mount.mock.calls[0][0]); // the host
    unmount();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("does NOT attach auto-copy-on-select when terminal.copyOnSelect is off", () => {
    __resetSettingsForTest();
    makeSettingsStore().set("terminal.copyOnSelect", false);
    const handle: TerminalHandle = { terminal: {} as never, renderer: "webgl", search: {} as never, fit: vi.fn(), dispose: vi.fn() };
    const attachCopyOnSelect = vi.fn<AttachCopyOnSelect>(() => () => {});
    render(
      <TerminalView
        mount={vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(() => handle)}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        attachOscIntegrations={noopAttachOsc}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={attachCopyOnSelect}
      />,
    );
    expect(attachCopyOnSelect).not.toHaveBeenCalled();
    __resetSettingsForTest(); // don't leak the off value to other tests
  });

  it("live-toggles auto-copy-on-select via settings:changed (detach off, re-attach on)", () => {
    __resetSettingsForTest();
    // A minimal `.options` so the sibling settings handlers (theme/font/…) don't crash on the fire below.
    const handle: TerminalHandle = { terminal: { options: {} } as never, renderer: "webgl", search: {} as never, fit: vi.fn(), dispose: vi.fn() };
    let fireSettings: ((payload: unknown) => void) | undefined;
    const observeSettings = vi.fn((onChange: (payload: unknown) => void) => {
      fireSettings = onChange;
      return () => {};
    });
    const detach = vi.fn();
    const attachCopyOnSelect = vi.fn<AttachCopyOnSelect>(() => detach);

    render(
      <TerminalView
        mount={vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(() => handle)}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        observeSettings={observeSettings}
        attachOscIntegrations={noopAttachOsc}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={attachCopyOnSelect}
      />,
    );
    expect(attachCopyOnSelect).toHaveBeenCalledTimes(1); // on by default

    fireSettings?.({ key: "terminal.copyOnSelect", value: false, source: "settings" });
    expect(detach).toHaveBeenCalledTimes(1); // toggled off → listeners removed

    fireSettings?.({ key: "terminal.copyOnSelect", value: true, source: "settings" });
    expect(attachCopyOnSelect).toHaveBeenCalledTimes(2); // toggled on → re-attached

    // An unrelated settings change does not re-toggle.
    fireSettings?.({ key: "appearance.theme", value: "solarized", source: "settings" });
    expect(attachCopyOnSelect).toHaveBeenCalledTimes(2);
  });

  it("calls onReady with the mounted handle so the parent can attach a PTY (C-2)", () => {
    const handle: TerminalHandle = {
      terminal: {} as never,
      renderer: "dom", search: {} as never,
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
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
      />,
    );

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(handle);
  });

  it("re-fits the terminal on resize and stops observing on unmount (issue 2: responsive content)", () => {
    const fit = vi.fn();
    const handle: TerminalHandle = {
      terminal: {} as never,
      renderer: "webgl", search: {} as never,
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
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
        resizeSchedule={immediateFrame}
      />,
    );

    // The component observes the very element it mounted the terminal into.
    expect(observeResize).toHaveBeenCalledTimes(1);
    expect(observeResize.mock.calls[0][0]).toBe(mount.mock.calls[0][0]);
    giveHostArea(mount.mock.calls[0][0]);

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
      renderer: "webgl", search: {} as never,
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
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
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
      renderer: "webgl", search: {} as never,
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
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
        resizeSchedule={immediateFrame}
      />,
    );
    giveHostArea(mount.mock.calls[0][0]);

    fireResize?.();

    // fit must run before recompute, otherwise the scrollbar would read stale rows/cols.
    expect(calls).toEqual(["fit", "recompute"]);
  });

  it("coalesces a resize burst to one fit on the next frame (trmx-67: a live drag floods ResizeObserver)", () => {
    const calls: string[] = [];
    const fit = vi.fn(() => calls.push("fit"));
    const handle: TerminalHandle = {
      terminal: {} as never,
      renderer: "webgl", search: {} as never,
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

    // Manual frame: capture the coalesced callback so the test decides when the frame fires.
    let frameCb: (() => void) | undefined;
    const resizeSchedule = (cb: () => void) => {
      frameCb = cb;
      return () => {};
    };

    render(
      <TerminalView
        mount={mount}
        observeResize={observeResize}
        attachScrollbar={attachScrollbar}
        attachOscIntegrations={noopAttachOsc}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
        resizeSchedule={resizeSchedule}
      />,
    );
    giveHostArea(mount.mock.calls[0][0]);

    // A drag burst: five observer ticks land inside one frame — nothing fits yet…
    for (let i = 0; i < 5; i++) fireResize?.();
    expect(fit).not.toHaveBeenCalled();

    // …then the frame fires exactly one fit, with the scrollbar recomputed after it.
    frameCb?.();
    expect(fit).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["fit", "recompute"]);
  });

  it("never fits a zero-area host, so a hidden window's 2×1 floor never reaches the PTY (trmx-67)", () => {
    const fit = vi.fn();
    const handle: TerminalHandle = {
      terminal: {} as never,
      renderer: "webgl", search: {} as never,
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

    const recompute = vi.fn();
    const attachScrollbar = vi.fn<AttachScrollbar>(() => ({
      recompute,
      dispose: vi.fn(),
    }));

    let frameCb: (() => void) | undefined;
    const resizeSchedule = (cb: () => void) => {
      frameCb = cb;
      return () => {};
    };

    render(
      <TerminalView
        mount={mount}
        observeResize={observeResize}
        attachScrollbar={attachScrollbar}
        attachOscIntegrations={noopAttachOsc}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
        resizeSchedule={resizeSchedule}
      />,
    );

    // The host keeps jsdom's 0×0 measurements — exactly the hidden/minimized-window shape. The
    // frame fires, but the zero-area skip keeps the fit (and the 2×1-floor artifact it would
    // emit upstream) away from the PTY entirely.
    fireResize?.();
    frameCb?.();
    expect(fit).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();
  });

  it("a frame that fires after unmount does not fit (trmx-67: coalescer dispose guard)", () => {
    const fit = vi.fn();
    const handle: TerminalHandle = {
      terminal: {} as never,
      renderer: "webgl", search: {} as never,
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

    let frameCb: (() => void) | undefined;
    const resizeSchedule = (cb: () => void) => {
      frameCb = cb;
      return () => {};
    };

    const { unmount } = render(
      <TerminalView
        mount={mount}
        observeResize={observeResize}
        attachScrollbar={noopAttachScrollbar}
        attachOscIntegrations={noopAttachOsc}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
        resizeSchedule={resizeSchedule}
      />,
    );
    giveHostArea(mount.mock.calls[0][0]);

    // A resize arrives, then the component unmounts before its frame fires. The captured frame
    // firing afterwards must be inert — the cleanup disposed the coalescer.
    fireResize?.();
    unmount();
    frameCb?.();
    expect(fit).not.toHaveBeenCalled();
  });

  it("re-themes the live terminal, syncs the backgrounds, and recomputes the scrollbar on a theme broadcast (trmx-53)", () => {
    // A terminal whose options.theme can be reassigned at runtime (xterm repaints on assignment).
    const terminal = { options: {} as { theme?: unknown } };
    const handle: TerminalHandle = {
      terminal: terminal as never,
      renderer: "webgl", search: {} as never,
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
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
      />,
    );

    expect(observeSettings).toHaveBeenCalledTimes(1);
    const host = mount.mock.calls[0][0];
    const body = host.ownerDocument.body;

    // The settings window picks Solarized → the terminal adopts it wholesale, without a remount.
    fireSettings?.({ key: "appearance.theme", value: "solarized", source: "settings" });
    expect(terminal.options.theme).toEqual(buildXtermTheme("solarized"));
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
      renderer: "webgl", search: {} as never,
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
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
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
      renderer: "webgl", search: {} as never,
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
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
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
      renderer: "webgl", search: {} as never,
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
        attachCopyOnSelect={noopAttachCopyOnSelect}
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

    // OSC 0/2 titles forward to the injected sink; 52, 7, 1337 (trmx-90), and 133 (trmx-99) are registered.
    titleHandler?.("hello from OSC 2");
    expect(setTitle).toHaveBeenCalledWith("hello from OSC 2");
    expect(oscRegistrations.map((r) => r.ident).sort((a, b) => a - b)).toEqual([7, 52, 133, 1337]);

    // One teardown disposes all subscriptions (title + 52 + 7 + 1337 + 133).
    teardown();
    expect(titleDispose).toHaveBeenCalledTimes(1);
    for (const r of oscRegistrations) expect(r.dispose).toHaveBeenCalledTimes(1);
  });

  it("realAttachOscIntegrations wires OSC 1337 SetBadgeFormat into the setBadge sink; teardown disposes it (trmx-90)", () => {
    // A capable fake that captures each OSC handler's callback + its disposer, so the test can feed
    // 1337 a SetBadgeFormat payload and confirm the sink fires, then that teardown unregisters it.
    const oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
    const oscDisposes = new Map<number, ReturnType<typeof vi.fn>>();
    const fakeTerminal = {
      onTitleChange: () => ({ dispose: vi.fn() }),
      parser: {
        registerOscHandler: (ident: number, cb: (data: string) => boolean | Promise<boolean>) => {
          oscHandlers.set(ident, cb);
          const dispose = vi.fn();
          oscDisposes.set(ident, dispose);
          return { dispose };
        },
      },
    };
    const setBadge = vi.fn();

    const teardown = realAttachOscIntegrations(fakeTerminal as never, {
      setTitle: vi.fn(),
      writeClipboard: vi.fn(),
      setBadge,
    });

    // SetBadgeFormat=<base64 "prod"> → the decoded, sanitized badge reaches the injected sink.
    oscHandlers.get(1337)?.(`SetBadgeFormat=${btoa("prod")}`);
    expect(setBadge).toHaveBeenCalledWith("prod");

    teardown();
    expect(oscDisposes.get(1337)).toHaveBeenCalledTimes(1);
  });

  it("routes OSC 1337 SetBadgeFormat into onBadge when provided — through the DEFAULT integrations (trmx-90)", () => {
    // The default seam runs the REAL realAttachOscIntegrations; a capable fake captures the 1337 cb.
    const oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
    const fakeTerminal = {
      onTitleChange: () => ({ dispose: vi.fn() }),
      parser: {
        registerOscHandler: (ident: number, cb: (data: string) => boolean | Promise<boolean>) => {
          oscHandlers.set(ident, cb);
          return { dispose: vi.fn() };
        },
      },
    };
    const handle: TerminalHandle = {
      terminal: fakeTerminal as never,
      renderer: "dom", search: {} as never,
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(() => handle);
    const onBadge = vi.fn();

    render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
        onBadge={onBadge}
      />,
    );

    // A program sets its badge via OSC 1337 — THIS pane's callback receives it (not the window).
    oscHandlers.get(1337)?.(`SetBadgeFormat=${btoa("db")}`);
    expect(onBadge).toHaveBeenCalledExactlyOnceWith("db");
  });

  it("threads onBadge through the attachOscIntegrations seam; absent stays undefined (trmx-90)", () => {
    const handle: TerminalHandle = {
      terminal: { id: "real-terminal" } as never,
      renderer: "webgl", search: {} as never,
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(() => handle);
    const attachOsc = vi.fn<AttachOscIntegrations>(() => () => {});
    const onBadge = vi.fn();

    render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        attachOscIntegrations={attachOsc}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
        onBadge={onBadge}
      />,
    );
    expect(attachOsc).toHaveBeenCalledTimes(1);
    expect(attachOsc.mock.calls[0][3]).toBe(onBadge); // 4th arg = onBadge

    // Without the prop the seam sees undefined — the badge simply has no destination.
    const attachOscAbsent = vi.fn<AttachOscIntegrations>(() => () => {});
    render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        attachOscIntegrations={attachOscAbsent}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
      />,
    );
    expect(attachOscAbsent).toHaveBeenCalledTimes(1);
    expect(attachOscAbsent.mock.calls[0][3]).toBeUndefined();
  });

  it("passes the injected per-tab cwdStore through the OSC seam (trmx-74)", () => {
    const handle: TerminalHandle = {
      terminal: { id: "real-terminal" } as never,
      renderer: "webgl", search: {} as never,
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );
    const attachOsc = vi.fn<AttachOscIntegrations>(() => () => {});
    const store = makeCwdStore();

    render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        attachOscIntegrations={attachOsc}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
        cwdStore={store}
      />,
    );

    expect(attachOsc).toHaveBeenCalledTimes(1);
    expect(attachOsc.mock.calls[0][0]).toBe(handle.terminal);
    expect(attachOsc.mock.calls[0][1]).toBe(store);
  });

  it("realAttachOscIntegrations threads an injected store into the OSC 7 handler — not the module default (trmx-74)", () => {
    // A capable fake that captures each OSC handler's CALLBACK so the test can feed it a report.
    const oscHandlers = new Map<number, (data: string) => boolean>();
    const fakeTerminal = {
      onTitleChange: () => ({ dispose: vi.fn() }),
      parser: {
        registerOscHandler: (ident: number, cb: (data: string) => boolean) => {
          oscHandlers.set(ident, cb);
          return { dispose: vi.fn() };
        },
      },
    };
    const store = makeCwdStore();

    realAttachOscIntegrations(
      fakeTerminal as never,
      { setTitle: vi.fn(), writeClipboard: vi.fn() },
      store,
    );

    oscHandlers.get(7)?.("file://mac/Users/me/proj");
    expect(store.get()).toBe("/Users/me/proj");
    // Per-tab isolation: the module-default store stays untouched by an injected-store terminal.
    expect(currentCwd()).toBeNull();
  });

  it("routes OSC 0/2 titles into onOscTitle when provided — through the DEFAULT integrations (trmx-75)", () => {
    // A capable fake terminal: the default seam runs the REAL realAttachOscIntegrations, which
    // needs onTitleChange (title) and parser.registerOscHandler (52/7).
    let titleHandler: ((t: string) => void) | undefined;
    const fakeTerminal = {
      onTitleChange: (h: (t: string) => void) => {
        titleHandler = h;
        return { dispose: vi.fn() };
      },
      parser: { registerOscHandler: () => ({ dispose: vi.fn() }) },
    };
    const handle: TerminalHandle = {
      terminal: fakeTerminal as never,
      renderer: "dom", search: {} as never,
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );
    const onOscTitle = vi.fn();

    render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
        onOscTitle={onOscTitle}
      />,
    );

    // The program retitles via OSC 2 — the TAB layer's callback receives it, not the window.
    titleHandler?.("build box");
    expect(onOscTitle).toHaveBeenCalledExactlyOnceWith("build box");
  });

  it("threads onOscTitle through the attachOscIntegrations seam; absent stays undefined (trmx-75)", () => {
    const handle: TerminalHandle = {
      terminal: { id: "real-terminal" } as never,
      renderer: "webgl", search: {} as never,
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );
    const attachOsc = vi.fn<AttachOscIntegrations>(() => () => {});
    const onOscTitle = vi.fn();

    render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        attachOscIntegrations={attachOsc}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
        onOscTitle={onOscTitle}
      />,
    );
    expect(attachOsc).toHaveBeenCalledTimes(1);
    expect(attachOsc.mock.calls[0][2]).toBe(onOscTitle);

    // Without the prop the seam sees undefined — the standalone (window-title) default persists.
    const attachOscAbsent = vi.fn<AttachOscIntegrations>(() => () => {});
    render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        attachOscIntegrations={attachOscAbsent}
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
      />,
    );
    expect(attachOscAbsent).toHaveBeenCalledTimes(1);
    expect(attachOscAbsent.mock.calls[0][2]).toBeUndefined();
  });

  it("re-fits + recomputes once when document.fonts.ready resolves (trmx-204 late-load backstop)", async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    Object.defineProperty(document, "fonts", { value: { ready }, configurable: true });
    try {
      const fit = vi.fn();
      const handle: TerminalHandle = { terminal: {} as never, renderer: "webgl", search: {} as never, fit, dispose: vi.fn() };
      const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(() => handle);
      const recompute = vi.fn();
      const attachScrollbar = vi.fn<AttachScrollbar>(() => ({ recompute, dispose: vi.fn() }));
      render(
        <TerminalView
          mount={mount}
          observeResize={noopObserve}
          attachScrollbar={attachScrollbar}
          attachOscIntegrations={noopAttachOsc}
          attachClipboard={noopAttachClipboard}
          attachCopyOnSelect={noopAttachCopyOnSelect}
          resizeSchedule={immediateFrame}
        />,
      );
      giveHostArea(mount.mock.calls[0][0]);
      expect(fit).not.toHaveBeenCalled();
      resolveReady();
      await Promise.resolve();
      await Promise.resolve();
      // A late-arriving face corrects the grid metrics exactly once (coalesced).
      expect(fit).toHaveBeenCalledTimes(1);
      expect(recompute).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
  });

  it("a fonts.ready that resolves AFTER unmount is inert (disposed terminal untouched)", async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    Object.defineProperty(document, "fonts", { value: { ready }, configurable: true });
    try {
      const fit = vi.fn();
      const handle: TerminalHandle = { terminal: {} as never, renderer: "webgl", search: {} as never, fit, dispose: vi.fn() };
      const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(() => handle);
      const { unmount } = render(
        <TerminalView
          mount={mount}
          observeResize={noopObserve}
          attachScrollbar={noopAttachScrollbar}
          attachOscIntegrations={noopAttachOsc}
          attachClipboard={noopAttachClipboard}
          attachCopyOnSelect={noopAttachCopyOnSelect}
          resizeSchedule={immediateFrame}
        />,
      );
      giveHostArea(mount.mock.calls[0][0]);
      unmount();
      resolveReady();
      await Promise.resolve();
      await Promise.resolve();
      expect(fit).not.toHaveBeenCalled();
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
  });

  it("applies scrollback + font broadcasts live; a FONT change re-fits and recomputes (trmx-80)", () => {
    // A terminal whose options can be reassigned at runtime (xterm applies on assignment).
    const terminal = {
      options: {} as { scrollback?: number; fontFamily?: string; fontSize?: number },
    };
    const fit = vi.fn();
    const handle: TerminalHandle = {
      terminal: terminal as never,
      renderer: "webgl", search: {} as never,
      fit,
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );

    let fireSettings: ((payload: unknown) => void) | undefined;
    const observeSettings = vi.fn((onChange: (payload: unknown) => void) => {
      fireSettings = onChange;
      return () => {};
    });

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
        attachClipboard={noopAttachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
      />,
    );

    // A scrollback change reassigns options.scrollback — a capacity change does NOT alter the
    // grid metrics, so no refit/recompute. (xterm truncates the buffer when the cap shrinks —
    // accepted, documented behavior, scrollbackSettings.ts.)
    fireSettings?.({ key: "terminal.scrollbackLines", value: 20_000, source: "settings" });
    expect(terminal.options.scrollback).toBe(20_000);
    expect(fit).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();

    // A font change alters the CELL METRICS: after applying it the view must re-fit the grid and
    // recompute the scrollbar geometry over the fresh rows/cols.
    fireSettings?.({ key: "terminal.fontSize", value: 14, source: "settings" });
    expect(terminal.options.fontSize).toBe(14);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(recompute).toHaveBeenCalledTimes(1);

    fireSettings?.({ key: "terminal.fontFamily", value: "Menlo", source: "settings" });
    expect(terminal.options.fontFamily).toBe("Menlo");
    expect(fit).toHaveBeenCalledTimes(2);
    expect(recompute).toHaveBeenCalledTimes(2);

    // Junk payloads are inert: no reassignment, no refit, no recompute.
    fireSettings?.({ key: "terminal.fontSize", value: "big", source: "settings" });
    fireSettings?.({ key: "terminal.scrollbackLines", value: "lots", source: "settings" });
    fireSettings?.("garbage");
    expect(terminal.options.scrollback).toBe(20_000);
    expect(terminal.options.fontSize).toBe(14);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  it("binds the clipboard guards to the host + terminal and unbinds on unmount (trmx-66)", () => {
    const teardown = vi.fn();
    const handle: TerminalHandle = {
      terminal: { id: "real-terminal" } as never,
      renderer: "webgl", search: {} as never,
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    const mount = vi.fn<(el: HTMLElement, deps: MountDeps) => TerminalHandle>(
      () => handle,
    );
    const attachClipboard = vi.fn<AttachClipboard>(() => teardown);

    const { unmount } = render(
      <TerminalView
        mount={mount}
        observeResize={noopObserve}
        attachScrollbar={noopAttachScrollbar}
        attachOscIntegrations={noopAttachOsc}
        attachClipboard={attachClipboard}
        attachCopyOnSelect={noopAttachCopyOnSelect}
      />,
    );

    expect(attachClipboard).toHaveBeenCalledTimes(1);
    expect(attachClipboard.mock.calls[0][0]).toBe(mount.mock.calls[0][0]); // the host
    expect(attachClipboard.mock.calls[0][1]).toBe(handle.terminal);

    unmount();
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
