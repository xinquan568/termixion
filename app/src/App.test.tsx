// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-74 (test-first): App is the TAB MANAGER — a useReducer shell over the pure tabState model
// wiring the strip, the per-tab persistent terminal hosts (keep-alive: a switch hides, never
// unmounts), the async attach flow (orphan guard when a tab dies mid-attach), pty:exited and
// menu `tabs:action` subscriptions, ⌘1..⌘9, cwd inheritance, and the last-tab-closes-the-window
// rule. TerminalView is stubbed (its behavior is covered by its own suite) with a recorder that
// mimics the real contract: onReady(handle) once per MOUNT, a cleanup counter to pin keep-alive.
// Every runtime edge (attach / closeWindow / closePty / event subscriptions) is injected via
// App's seam props, so this runs headless with controllable SessionInfo promises.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { StrictMode } from "react";
import type { SessionInfo } from "./ipc/backend";
import type { TerminalHandle } from "./terminal/mountTerminal";

// Hoisted recorder shared with the TerminalView stub (vi.mock factories run before the test
// body's bindings exist). One entry per stub MOUNT: the fake handle it announced and the per-tab
// cwdStore App injected; `unmounts` counts stub cleanups (must stay 0 across tab switches).
const recorder = vi.hoisted(() => ({
  mounts: [] as Array<{
    handle: { terminal: { focus: () => void } };
    cwdStore: { get(): string | null; set(cwd: string): void } | undefined;
  }>,
  unmounts: 0,
  reset() {
    this.mounts.length = 0;
    this.unmounts = 0;
  },
}));

vi.mock("./terminal/TerminalView", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalView: ({
      onReady,
      cwdStore,
    }: {
      onReady?: (handle: unknown) => void;
      cwdStore?: { get(): string | null; set(cwd: string): void };
    }) => {
      useEffect(() => {
        const handle = {
          terminal: { focus: vi.fn() },
          renderer: "dom",
          fit: () => {},
          dispose: () => {},
        };
        recorder.mounts.push({ handle, cwdStore });
        onReady?.(handle);
        return () => {
          recorder.unmounts += 1;
        };
        // The real TerminalView remounts when these identities change — mirroring that makes the
        // keep-alive test honest: an unstable onReady/cwdStore from App would count an unmount.
      }, [onReady, cwdStore]);
      return <div data-testid="terminal-view-stub" />;
    },
  };
});
vi.mock("./ipc/useBackend", () => ({
  useBackend: () => ({ coreVersion: "0.0.2", attachTerminal: vi.fn() }),
}));
// trmx-51: UpdateAuthorityHost wires the real Tauri edges (updater client, event bus); stub it so
// this stays a headless tab-manager test (its behavior is covered by the useUpdateAuthority spec).
vi.mock("./update/UpdateAuthorityHost", () => ({
  UpdateAuthorityHost: () => <div data-testid="update-authority-host" />,
}));

import { App, type AppProps } from "./App";

interface AttachCall {
  handle: unknown;
  opts: { cwd?: string } | undefined;
  resolve: (info: SessionInfo) => void;
  reject: (err: unknown) => void;
}

// A controllable attach: each call parks its resolvers so tests decide when (and whether) the
// backend "answers" — the mid-attach close and cwd-inheritance cases need exactly this.
function makeAttach() {
  const calls: AttachCall[] = [];
  const attach = vi.fn(
    (handle: TerminalHandle, opts?: { cwd?: string }) =>
      new Promise<SessionInfo>((resolve, reject) => {
        calls.push({ handle, opts, resolve, reject });
      }),
  );
  return { attach, calls };
}

// A capturable observation seam (tabs:action / pty:exited): tests fire the captured handler.
function makeObservation<T>() {
  let handler: ((value: T) => void) | undefined;
  const teardown = vi.fn();
  const observe = vi.fn((h: (value: T) => void) => {
    handler = h;
    return teardown;
  });
  return { observe, teardown, fire: (value: T) => handler?.(value) };
}

function renderApp(opts: { strict?: boolean } = {}) {
  const { attach, calls } = makeAttach();
  const closeWindow = vi.fn();
  const closeSession = vi.fn(() => Promise.resolve());
  const tabsAction = makeObservation<unknown>();
  const ptyExited = makeObservation<number>();
  const props: AppProps = {
    attach,
    closeWindow,
    closeSession,
    observeTabsAction: tabsAction.observe,
    observePtyExited: ptyExited.observe,
  };
  const ui = opts.strict ? (
    <StrictMode>
      <App {...props} />
    </StrictMode>
  ) : (
    <App {...props} />
  );
  const view = render(ui);
  return { view, attach, calls, closeWindow, closeSession, tabsAction, ptyExited };
}

async function resolveAttach(call: AttachCall, info: SessionInfo) {
  await act(async () => {
    call.resolve(info);
  });
}

const activeClass = "tab-strip__tab--active";

// Strip-tab activation is pointerup-without-slop (TabStrip's drag detection), so a "click" on a
// tab is the pointer sequence; plain buttons (+ / ×) take a plain click.
function clickTab(tabId: number) {
  const el = screen.getByTestId(`tab-${tabId}`);
  fireEvent.pointerDown(el, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
  fireEvent.pointerUp(el, { pointerId: 1, clientX: 10, clientY: 10 });
}

beforeEach(() => {
  recorder.reset();
});

describe("App (the tab manager, trmx-74)", () => {
  it("boots with exactly ONE tab and attaches its terminal (StrictMode-safe)", async () => {
    const { attach, calls } = renderApp({ strict: true });

    // StrictMode double-fires the boot effect; the ref guard keeps it to one openTab.
    expect(screen.getByTestId("tab-1")).toBeInTheDocument();
    expect(screen.getByTestId("tab-host-1")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("update-authority-host")).toBeInTheDocument();

    // The mounted terminal was attached (StrictMode remounts the stub, so ≥1 attach; the LAST
    // mount is the live one).
    expect(attach).toHaveBeenCalled();
    await resolveAttach(calls[calls.length - 1], { sessionId: 7, title: "zsh" });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("zsh");
  });

  it("renders no in-page chrome beyond the strip (trmx-35: the terminal owns the window)", () => {
    renderApp();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByTestId("core-version")).not.toBeInTheDocument();
  });

  it("keeps every tab's terminal MOUNTED across switches (keep-alive), hiding inactive hosts", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });

    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 2, title: "two" });

    // The new tab is active; BOTH hosts stay in the DOM, the inactive one display:none.
    expect(screen.getByTestId("tab-host-2")).toBeVisible();
    expect(screen.getByTestId("tab-host-1")).not.toBeVisible();

    clickTab(1);
    expect(screen.getByTestId("tab-host-1")).toBeVisible();
    expect(screen.getByTestId("tab-host-2")).not.toBeVisible();

    // The keep-alive invariant: no TerminalView ever unmounted on a switch.
    expect(recorder.unmounts).toBe(0);
    expect(recorder.mounts).toHaveLength(2);
    // Focus follows activation into the newly active tab's terminal.
    expect(recorder.mounts[0].handle.terminal.focus).toHaveBeenCalled();
  });

  it("disposes the orphan session when a tab closes before its attach resolves (orphan guard)", async () => {
    const { calls, closeSession } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });

    fireEvent.click(screen.getByTestId("tab-new"));
    expect(calls).toHaveLength(2); // tab 2's attach is in flight

    fireEvent.click(screen.getByTestId("tab-close-2"));
    expect(screen.queryByTestId("tab-2")).not.toBeInTheDocument();
    expect(closeSession).not.toHaveBeenCalled(); // nothing attached yet — nothing to close

    // The open resolves AFTER the tab died: the session is disposed, the tab stays dead.
    await resolveAttach(calls[1], { sessionId: 99, title: "late" });
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(99);
    expect(screen.queryByTestId("tab-2")).not.toBeInTheDocument();
  });

  it("closing an attached background tab closes ITS pty (close_pty), not the active one's", async () => {
    const { calls, closeSession } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });

    fireEvent.click(screen.getByTestId("tab-close-1")); // background tab
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(11);
    expect(screen.queryByTestId("tab-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-2").className).toContain(activeClass);
  });

  it("a pty:exited for a background tab closes THAT tab only — without a redundant close_pty", async () => {
    const { calls, closeSession, ptyExited } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });

    await act(async () => {
      ptyExited.fire(11);
    });

    expect(screen.queryByTestId("tab-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tab-host-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-2")).toBeInTheDocument();
    expect(screen.getByTestId("tab-2").className).toContain(activeClass);
    // The child already exited — App must NOT close_pty the dead session (or any other).
    expect(closeSession).not.toHaveBeenCalled();

    // A junk/unknown sessionId is inert.
    await act(async () => {
      ptyExited.fire(4040);
    });
    expect(screen.getByTestId("tab-2")).toBeInTheDocument();
  });

  it("closing the LAST tab closes the window instead of dispatching a broken state", async () => {
    const { calls, closeWindow, closeSession } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });

    fireEvent.click(screen.getByTestId("tab-close-1"));

    expect(closeWindow).toHaveBeenCalledTimes(1);
    // No dispatch: the tab (and its terminal) stay mounted while the window goes down, and no
    // per-session close is sent — the backend's CloseRequested kill_all owns cleanup.
    expect(screen.getByTestId("tab-1")).toBeInTheDocument();
    expect(screen.getByTestId("tab-host-1")).toBeInTheDocument();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("renders the Shell placeholder until attach resolves the SessionInfo title", async () => {
    const { calls } = renderApp();
    expect(screen.getByTestId("tab-1")).toHaveTextContent("Shell");
    await resolveAttach(calls[0], { sessionId: 5, title: "-zsh" });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("-zsh");
  });

  it("drives new/next/close from tabs:action broadcasts; junk payloads are inert", async () => {
    const { calls, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });

    await act(async () => {
      tabsAction.fire("new");
    });
    expect(screen.getByTestId("tab-2")).toBeInTheDocument();
    expect(screen.getByTestId("tab-2").className).toContain(activeClass);

    await act(async () => {
      tabsAction.fire("next"); // wraps 2 → 1
    });
    expect(screen.getByTestId("tab-1").className).toContain(activeClass);

    await act(async () => {
      tabsAction.fire("close"); // closes the ACTIVE tab (1); neighbor 2 takes over
    });
    expect(screen.queryByTestId("tab-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-2").className).toContain(activeClass);

    await act(async () => {
      tabsAction.fire(42);
      tabsAction.fire({ verb: "new" });
      tabsAction.fire("prev"); // single tab: wrap-to-self no-op
    });
    expect(screen.queryByTestId("tab-3")).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-2").className).toContain(activeClass);
  });

  it("selects tabs with ⌘1..⌘9 via the capture-phase window keydown (tabKeymap)", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 2, title: "two" });

    fireEvent.keyDown(document.body, { key: "1", metaKey: true });
    expect(screen.getByTestId("tab-1").className).toContain(activeClass);
    fireEvent.keyDown(document.body, { key: "2", metaKey: true });
    expect(screen.getByTestId("tab-2").className).toContain(activeClass);
    // A bare digit (no ⌘) is never intercepted.
    fireEvent.keyDown(document.body, { key: "1" });
    expect(screen.getByTestId("tab-2").className).toContain(activeClass);
  });

  it("a new tab inherits the ACTIVE tab's OSC 7 cwd — even while that tab is still mid-attach", () => {
    const { attach } = renderApp();
    // Tab 1's attach never resolves here (mid-attach). Its per-tab store exists from MOUNT, so an
    // OSC 7 report can land before the session does — prime it the way attachOsc7 would.
    expect(recorder.mounts[0].cwdStore).toBeDefined();
    recorder.mounts[0].cwdStore?.set("/tmp");

    fireEvent.click(screen.getByTestId("tab-new"));

    expect(attach).toHaveBeenCalledTimes(2);
    // The boot tab had nothing to inherit; the new tab carries the active tab's cwd.
    expect(attach.mock.calls[0][1]).toEqual({ cwd: undefined });
    expect(attach.mock.calls[1][1]).toEqual({ cwd: "/tmp" });
    // Each tab got its OWN store (per-tab cwd isolation).
    expect(recorder.mounts[1].cwdStore).toBeDefined();
    expect(recorder.mounts[1].cwdStore).not.toBe(recorder.mounts[0].cwdStore);
  });

  it("reorders tabs from the strip's onMove without remounting terminals", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 2, title: "two" });

    // Lay the two tabs out side by side and drag tab-1 past tab-2's midpoint.
    for (const [i, id] of [1, 2].entries()) {
      screen.getByTestId(`tab-${id}`).getBoundingClientRect = () =>
        ({ left: i * 100, width: 100, right: i * 100 + 100, top: 0, bottom: 34, height: 34, x: i * 100, y: 0, toJSON: () => ({}) }) as DOMRect;
    }
    const el = screen.getByTestId("tab-1");
    fireEvent.pointerDown(el, { pointerId: 2, clientX: 50, clientY: 10, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 2, clientX: 160, clientY: 10 });
    fireEvent.pointerUp(el, { pointerId: 2, clientX: 160, clientY: 10 });

    const strip = screen.getByTestId("tab-strip");
    const order = Array.from(strip.querySelectorAll("[data-tabstrip-item]"), (t) =>
      t.getAttribute("data-testid"),
    );
    expect(order).toEqual(["tab-2", "tab-1"]);
    // Reordering is a state permutation, not a remount; keyed hosts survive.
    expect(recorder.unmounts).toBe(0);
    expect(screen.getByTestId("tab-2").className).toContain(activeClass); // identity, not index
  });
});
