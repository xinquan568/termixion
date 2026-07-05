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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { StrictMode } from "react";
import type { SessionInfo } from "./ipc/backend";
import type { FrameSchedule } from "./terminal/resizeCoalescer";
import type { TerminalHandle } from "./terminal/mountTerminal";

// Hoisted recorder shared with the TerminalView stub (vi.mock factories run before the test
// body's bindings exist). One entry per stub MOUNT: the fake handle it announced, the per-tab
// cwdStore App injected, and the per-tab onOscTitle callback (trmx-75 — tests fire it to simulate
// a program's OSC 0/2 title); `unmounts` counts stub cleanups (must stay 0 across tab switches).
const recorder = vi.hoisted(() => ({
  mounts: [] as Array<{
    handle: { terminal: { focus: () => void } };
    cwdStore: { get(): string | null; set(cwd: string): void } | undefined;
    onOscTitle: ((title: string) => void) | undefined;
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
      onOscTitle,
    }: {
      onReady?: (handle: unknown) => void;
      cwdStore?: { get(): string | null; set(cwd: string): void };
      onOscTitle?: (title: string) => void;
    }) => {
      useEffect(() => {
        const handle = {
          terminal: { focus: vi.fn() },
          renderer: "dom",
          fit: () => {},
          dispose: () => {},
        };
        recorder.mounts.push({ handle, cwdStore, onOscTitle });
        onReady?.(handle);
        return () => {
          recorder.unmounts += 1;
        };
        // The real TerminalView remounts when these identities change — mirroring that makes the
        // keep-alive test honest: an unstable onReady/cwdStore/onOscTitle from App would count an
        // unmount (trmx-75: the per-tab OSC callback must be cached like onReady).
      }, [onReady, cwdStore, onOscTitle]);
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
import { makeSettingsStore, __resetSettingsForTest } from "./settings/settingsStore";

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

// The title-hint seam carries TWO values (sessionId, name) — same capture pattern (trmx-75).
function makeHintObservation() {
  let handler: ((sessionId: number, name: string) => void) | undefined;
  const teardown = vi.fn();
  const observe = vi.fn((h: (sessionId: number, name: string) => void) => {
    handler = h;
    return teardown;
  });
  return {
    observe,
    teardown,
    fire: (sessionId: number, name: string) => handler?.(sessionId, name),
  };
}

// A controllable frame schedule for the divider-drag rAF coalescing (trmx-85): the test flushes the
// pending frame deterministically and `scheduleCalls` proves coalescing (many moves → one frame).
function makeFrameSchedule() {
  let pending: (() => void) | null = null;
  let scheduleCalls = 0;
  const schedule: FrameSchedule = (cb) => {
    scheduleCalls += 1;
    pending = cb;
    return () => {
      pending = null;
    };
  };
  return {
    schedule,
    flush() {
      const cb = pending;
      pending = null;
      cb?.();
    },
    hasPending: () => pending !== null,
    get scheduleCalls() {
      return scheduleCalls;
    },
  };
}

function renderApp(opts: { strict?: boolean } = {}) {
  const { attach, calls } = makeAttach();
  const frame = makeFrameSchedule();
  const closeWindow = vi.fn();
  const closeSession = vi.fn(() => Promise.resolve());
  const tabsAction = makeObservation<unknown>();
  const ptyExited = makeObservation<number>();
  const titleHint = makeHintObservation();
  const settingsChanged = makeObservation<unknown>(); // trmx-81: settings:changed broadcasts
  const setWindowTitle = vi.fn();
  const mirrorTitle = vi.fn(() => Promise.resolve());
  const props: AppProps = {
    attach,
    closeWindow,
    closeSession,
    observeTabsAction: tabsAction.observe,
    observePtyExited: ptyExited.observe,
    observeTitleHint: titleHint.observe,
    observeSettings: settingsChanged.observe,
    setWindowTitle,
    mirrorTitle,
    dragSchedule: frame.schedule,
  };
  const ui = opts.strict ? (
    <StrictMode>
      <App {...props} />
    </StrictMode>
  ) : (
    <App {...props} />
  );
  const view = render(ui);
  return {
    view,
    attach,
    calls,
    closeWindow,
    closeSession,
    tabsAction,
    ptyExited,
    titleHint,
    settingsChanged,
    setWindowTitle,
    mirrorTitle,
    frame,
  };
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

  it("closes the STALE session when StrictMode double-mounts a tab's terminal (attach epoch)", async () => {
    // StrictMode's dev mount→unmount→remount invokes onReady twice for the SAME live tab, so two
    // PTYs open; only the CURRENT epoch's session may be kept, whichever order the opens resolve.
    const { calls, closeSession } = renderApp({ strict: true });
    expect(calls.length).toBe(2); // two mounts → two in-flight attaches for tab 1

    // Order A: the stale (first-mount) attach resolves FIRST — it must be disposed, and the
    // later (current-epoch) resolution attaches.
    await resolveAttach(calls[0], { sessionId: 41, title: "stale" });
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(41);
    await resolveAttach(calls[1], { sessionId: 42, title: "live" });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("live");
    expect(closeSession).toHaveBeenCalledTimes(1); // the live session was NOT closed
  });

  it("closes the STALE session even when it resolves AFTER the current epoch's (attach epoch, reversed order)", async () => {
    const { calls, closeSession } = renderApp({ strict: true });
    expect(calls.length).toBe(2);

    // Order B: the current epoch resolves first and attaches; the stale one lands late and is
    // disposed instead of clobbering the live session.
    await resolveAttach(calls[1], { sessionId: 52, title: "live" });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("live");
    expect(closeSession).not.toHaveBeenCalled();
    await resolveAttach(calls[0], { sessionId: 51, title: "stale" });
    expect(closeSession).toHaveBeenCalledExactlyOnceWith(51);
    expect(screen.getByTestId("tab-1")).toHaveTextContent("live");
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

// trmx-75 (FR-2.4): title routing — per-tab OSC callbacks, session:title-hint → process slot,
// the native window title (ACTIVE tab only), and the core mirror (EFFECTIVE titles only).
describe("App tab titles (trmx-75)", () => {
  // Boot two attached tabs: tab 1 (session 11, "one") in the background, tab 2 (session 22,
  // "two") active — the canonical isolation fixture.
  async function twoTabs() {
    const ctx = renderApp();
    await resolveAttach(ctx.calls[0], { sessionId: 11, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(ctx.calls[1], { sessionId: 22, title: "two" });
    return ctx;
  }

  it("routes a BACKGROUND tab's OSC title to its own label only — the window title never sees it", async () => {
    const { setWindowTitle } = await twoTabs();

    await act(async () => {
      recorder.mounts[0].onOscTitle?.("secret build"); // tab 1 is hidden behind tab 2
    });

    expect(screen.getByTestId("tab-1")).toHaveTextContent("secret build");
    expect(screen.getByTestId("tab-2")).toHaveTextContent("two");
    // Background isolation: only the ACTIVE tab's title ever reaches the native window.
    expect(setWindowTitle).not.toHaveBeenCalledWith("secret build");
    expect(setWindowTitle).toHaveBeenLastCalledWith("two");
  });

  it("the native window title follows the ACTIVE tab across switches", async () => {
    const { setWindowTitle } = await twoTabs();
    expect(setWindowTitle).toHaveBeenLastCalledWith("two");

    clickTab(1);
    expect(setWindowTitle).toHaveBeenLastCalledWith("one");
    clickTab(2);
    expect(setWindowTitle).toHaveBeenLastCalledWith("two");
  });

  it("an empty OSC title clears the slot — the tab reverts to the automatic layers", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "zsh" });

    await act(async () => {
      recorder.mounts[0].onOscTitle?.("running tests");
    });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("running tests");

    // The program resets its title (printf '\e]2;\a') — back to the fallback.
    await act(async () => {
      recorder.mounts[0].onOscTitle?.("");
    });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("zsh");
  });

  it("routes session:title-hint by sessionId into the process slot; an unknown session is inert", async () => {
    const { calls, titleHint } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "zsh" });

    await act(async () => {
      titleHint.fire(11, "vim");
    });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("vim");

    // A hint for a session no tab owns (raced a close, or junk) dispatches nothing.
    await act(async () => {
      titleHint.fire(999, "ghost");
    });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("vim");
    expect(screen.getByTestId("tab-strip")).not.toHaveTextContent("ghost");
  });

  it("mirrors the EFFECTIVE title to the core — a process hint under a manual title never reaches it", async () => {
    const { calls, titleHint, mirrorTitle } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "zsh" });
    // The attach itself mirrors the effective title into the core session.
    expect(mirrorTitle).toHaveBeenCalledWith(11, "zsh");

    // Prime MANUAL via the real rename path (double-click the label, type, Enter).
    fireEvent.doubleClick(screen.getByTitle("zsh"));
    fireEvent.change(screen.getByTestId("tab-rename-input"), {
      target: { value: "My Tab" },
    });
    fireEvent.keyDown(screen.getByTestId("tab-rename-input"), { key: "Enter" });
    expect(mirrorTitle).toHaveBeenCalledWith(11, "My Tab");
    const countAfterRename = mirrorTitle.mock.calls.length;

    // A process hint lands in the sources but manual outranks it: the EFFECTIVE title is
    // unchanged, so the mirror must not fire — and must NEVER carry the raw hint value.
    await act(async () => {
      titleHint.fire(11, "vim");
    });
    expect(mirrorTitle).not.toHaveBeenCalledWith(11, "vim");
    expect(mirrorTitle.mock.calls.length).toBe(countAfterRename);
  });

  it("never mirrors a title for a tab whose session has not attached", async () => {
    const { mirrorTitle } = renderApp(); // the attach stays in flight

    await act(async () => {
      recorder.mounts[0].onOscTitle?.("early bird");
    });

    expect(screen.getByTestId("tab-1")).toHaveTextContent("early bird");
    expect(mirrorTitle).not.toHaveBeenCalled();
  });
});

// trmx-75 (FR-2.4): the rename UI — menu path, double-click path, focus discipline (the input
// owns the keyboard until commit/cancel; then the terminal takes it back), keymap inertness.
describe("App rename (trmx-75)", () => {
  it("menu 'rename' (tabs:action) opens the inline input on the ACTIVE tab", async () => {
    const { calls, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });

    await act(async () => {
      tabsAction.fire("rename");
    });

    const input = screen.getByTestId("tab-rename-input") as HTMLInputElement;
    expect(input.value).toBe("two"); // the ACTIVE tab (2), not tab 1
    fireEvent.change(input, { target: { value: "deploy" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("tab-2")).toHaveTextContent("deploy");
    expect(screen.getByTestId("tab-1")).toHaveTextContent("one");
  });

  it("double-click on an INACTIVE tab activates it AND starts rename; the input keeps focus; commit refocuses the terminal", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });
    // Active = 2; tab 1 is in the background. Its terminal focus() spy:
    const tab1Focus = recorder.mounts[0].handle.terminal.focus as ReturnType<typeof vi.fn>;
    const focusCallsBefore = tab1Focus.mock.calls.length;

    // The double-click path: activation fires first, then rename — the suppression must keep
    // focus-follows-activation from stealing the input's focus.
    fireEvent.doubleClick(screen.getByTitle("one"));

    const input = screen.getByTestId("tab-rename-input") as HTMLInputElement;
    expect(screen.getByTestId("tab-1").className).toContain(activeClass); // activated
    expect(document.activeElement).toBe(input); // …and the INPUT holds focus
    expect(tab1Focus.mock.calls.length).toBe(focusCallsBefore); // suppressed while renaming

    // Commit: the input goes away, the ACTIVE tab's terminal takes the keyboard back.
    fireEvent.change(input, { target: { value: "build box" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByTestId("tab-rename-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-1")).toHaveTextContent("build box");
    expect(tab1Focus.mock.calls.length).toBe(focusCallsBefore + 1);
  });

  it("cancel (Esc) discards the edit and refocuses the terminal", async () => {
    const { calls, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    const tab1Focus = recorder.mounts[0].handle.terminal.focus as ReturnType<typeof vi.fn>;

    await act(async () => {
      tabsAction.fire("rename");
    });
    const focusCallsBefore = tab1Focus.mock.calls.length;
    const input = screen.getByTestId("tab-rename-input");
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("tab-rename-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-1")).toHaveTextContent("one"); // unchanged
    expect(tab1Focus.mock.calls.length).toBe(focusCallsBefore + 1); // focus returned
  });

  it("⌘1..⌘9 are inert while the rename input has focus (editable non-terminal target)", async () => {
    const { calls, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });
    clickTab(1);
    expect(screen.getByTestId("tab-1").className).toContain(activeClass);

    await act(async () => {
      tabsAction.fire("rename");
    });
    // The chord lands ON the input (capture-phase window listener sees target=input) — the
    // describeTarget veto (editable, non-terminal) must keep it a plain keystroke.
    fireEvent.keyDown(screen.getByTestId("tab-rename-input"), { key: "2", metaKey: true });
    expect(screen.getByTestId("tab-1").className).toContain(activeClass);
    expect(screen.queryByTestId("tab-rename-input")).toBeInTheDocument(); // still editing
  });

  it("manual-clear (empty commit) reverts the title to the automatic layers (process hint here)", async () => {
    const { calls, titleHint } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "zsh" });
    await act(async () => {
      titleHint.fire(11, "vim");
    });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("vim");

    // Rename to a manual title…
    fireEvent.doubleClick(screen.getByTitle("vim"));
    fireEvent.change(screen.getByTestId("tab-rename-input"), { target: { value: "Build" } });
    fireEvent.keyDown(screen.getByTestId("tab-rename-input"), { key: "Enter" });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("Build");

    // …then clear it (whitespace-only counts as empty): the process hint resurfaces.
    fireEvent.doubleClick(screen.getByTitle("Build"));
    const input = screen.getByTestId("tab-rename-input") as HTMLInputElement;
    expect(input.value).toBe("Build"); // seeded with the CURRENT title
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("vim");
  });

  it("closing the renamed tab (pty:exited) clears rename state so focus-follows-activation resumes", async () => {
    const { calls, tabsAction, ptyExited } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });

    await act(async () => {
      tabsAction.fire("rename"); // renaming the ACTIVE tab 2
    });
    expect(screen.getByTestId("tab-rename-input")).toBeInTheDocument();

    const tab1Focus = recorder.mounts[0].handle.terminal.focus as ReturnType<typeof vi.fn>;
    const focusCallsBefore = tab1Focus.mock.calls.length;
    await act(async () => {
      ptyExited.fire(22); // the renamed tab's shell dies mid-edit
    });

    // The input died with its tab; rename state cleared, so the surviving neighbor's terminal
    // takes focus (a stuck renamingTabId would suppress activation-focus forever).
    expect(screen.queryByTestId("tab-rename-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-1").className).toContain(activeClass);
    expect(tab1Focus.mock.calls.length).toBe(focusCallsBefore + 1);
  });
});

// trmx-81 (FR-2.2): the tab-bar position. App seeds it from the shared settings snapshot, applies
// it as an `app--bar-<position>` class on main.app (JSX order NEVER changes — flex direction does
// the moving, barLayout.ts), keeps it live over settings:changed, and passes the strip its
// orientation. A position switch must never remount a tab host (the trmx-74 keep-alive lesson).
describe("App tab-bar position (trmx-81)", () => {
  const mainEl = (view: ReturnType<typeof renderApp>["view"]) =>
    view.container.querySelector("main.app")!;

  // These tests touch the module-level shared snapshot — reset it so no state leaks across tests.
  afterEach(() => {
    __resetSettingsForTest();
  });

  it("defaults to the bottom bar: app--bar-bottom and a horizontal strip", () => {
    const { view } = renderApp();
    expect(mainEl(view).className).toBe("app app--bar-bottom");
    expect(screen.getByTestId("tab-strip").className).toBe("tab-strip");
  });

  it("seeds the position from the settings store snapshot", () => {
    makeSettingsStore().set("tabs.barPosition", "left"); // the shared snapshot, as hydration would
    const { view } = renderApp();
    expect(mainEl(view).className).toBe("app app--bar-left");
    // A side position renders the strip as a vertical rail.
    expect(screen.getByTestId("tab-strip").className).toBe("tab-strip tab-strip--vertical");
  });

  it("a settings:changed for tabs.barPosition switches the class WITHOUT remounting tab hosts", async () => {
    const { view, calls, settingsChanged } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 2, title: "two" });

    // Capture the host DOM nodes BEFORE the switch — their identity must survive it.
    const host1 = screen.getByTestId("tab-host-1");
    const host2 = screen.getByTestId("tab-host-2");
    const unmountsBefore = recorder.unmounts;

    await act(async () => {
      settingsChanged.fire({ key: "tabs.barPosition", value: "right", source: "config-file" });
    });

    expect(mainEl(view).className).toBe("app app--bar-right");
    expect(screen.getByTestId("tab-strip").className).toBe("tab-strip tab-strip--vertical");
    // Keep-alive across the layout flip: same DOM nodes, zero TerminalView unmounts.
    expect(screen.getByTestId("tab-host-1")).toBe(host1);
    expect(screen.getByTestId("tab-host-2")).toBe(host2);
    expect(recorder.unmounts).toBe(unmountsBefore);

    // And back to a horizontal edge.
    await act(async () => {
      settingsChanged.fire({ key: "tabs.barPosition", value: "top", source: "settings-window" });
    });
    expect(mainEl(view).className).toBe("app app--bar-top");
    expect(screen.getByTestId("tab-strip").className).toBe("tab-strip");
    expect(screen.getByTestId("tab-host-1")).toBe(host1);
    expect(recorder.unmounts).toBe(unmountsBefore);
  });

  it("junk settings:changed payloads are inert (wrong shape, wrong key, invalid value)", async () => {
    const { view, settingsChanged } = renderApp();
    await act(async () => {
      settingsChanged.fire("garbage");
      settingsChanged.fire(42);
      settingsChanged.fire({ key: "tabs.barPosition", value: "middle", source: "config-file" });
      settingsChanged.fire({ key: "tabs.barPosition", value: 7, source: "config-file" });
      settingsChanged.fire({ key: "appearance.theme", value: "left", source: "config-file" });
    });
    expect(mainEl(view).className).toBe("app app--bar-bottom");
  });

  it("tears the settings subscription down on unmount", () => {
    const { view, settingsChanged } = renderApp();
    expect(settingsChanged.observe).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(settingsChanged.teardown).toHaveBeenCalledTimes(1);
  });
});

// trmx-82 (FR-2.3): the side-bar label orientation. App reads tabs.sideLabelOrientation alongside
// the bar position (ONE settings subscription, two keys), gates it through labelOrientationFor
// (top/bottom force horizontal), and passes the strip its labelOrientation. The railGeometryFor
// tokens are OWNED by TabStrip (it writes them on its root in vertical-label mode — unit-pinned in
// TabStrip.test.tsx); here we assert they still arrive END-TO-END through App's render, and that
// App writes none of its own (outside vertical-label mode the strip carries NO geometry vars —
// those layouts are CSS-owned constants).
describe("App side-bar label orientation (trmx-82)", () => {
  const strip = () => screen.getByTestId("tab-strip");
  const stripVar = (name: string) => strip().style.getPropertyValue(name);

  // These tests touch the module-level shared snapshot — reset it so no state leaks across tests.
  afterEach(() => {
    __resetSettingsForTest();
  });

  it("side bar + vertical setting → labelOrientation reaches the strip; narrow-rail CSS vars", () => {
    makeSettingsStore().set("tabs.barPosition", "left");
    makeSettingsStore().set("tabs.sideLabelOrientation", "vertical");
    renderApp();
    expect(strip().className).toBe("tab-strip tab-strip--vertical tab-strip--labels-vertical");
    // The railGeometryFor tokens, verbatim, END-TO-END: TabStrip owns them, App's render carries
    // them onto the strip container.
    expect(stripVar("--tab-rail-width")).toBe("44px");
    expect(stripVar("--tab-max-height")).toBe("180px");
    expect(stripVar("--tab-min-height")).toBe("60px");
    expect(stripVar("--tab-close-min")).toBe("24px");
  });

  it("a top/bottom bar forces horizontal labels even when the setting is vertical", () => {
    makeSettingsStore().set("tabs.sideLabelOrientation", "vertical"); // bar stays on the bottom
    renderApp();
    expect(strip().className).toBe("tab-strip");
    // No geometry vars outside vertical-label mode — the horizontal strip is CSS-owned.
    expect(stripVar("--tab-rail-width")).toBe("");
    expect(stripVar("--tab-max-height")).toBe("");
    expect(stripVar("--tab-min-height")).toBe("");
    expect(stripVar("--tab-close-min")).toBe("");
  });

  it("a side bar with the DEFAULT setting keeps the trmx-81 rail (no vars, no label class)", () => {
    makeSettingsStore().set("tabs.barPosition", "right");
    renderApp();
    expect(strip().className).toBe("tab-strip tab-strip--vertical");
    // The horizontal-label rail's 180px width is a CSS-owned constant, not a token.
    expect(stripVar("--tab-rail-width")).toBe("");
  });

  it("settings:changed flips the labels live over the ONE subscription, without remounting hosts", async () => {
    makeSettingsStore().set("tabs.barPosition", "right");
    const { calls, settingsChanged } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    expect(settingsChanged.observe).toHaveBeenCalledTimes(1); // one subscription serves both keys
    const host1 = screen.getByTestId("tab-host-1");
    const unmountsBefore = recorder.unmounts;

    await act(async () => {
      settingsChanged.fire({
        key: "tabs.sideLabelOrientation",
        value: "vertical",
        source: "settings-window",
      });
    });
    expect(strip().className).toBe("tab-strip tab-strip--vertical tab-strip--labels-vertical");
    expect(stripVar("--tab-rail-width")).toBe("44px");

    await act(async () => {
      settingsChanged.fire({
        key: "tabs.sideLabelOrientation",
        value: "horizontal",
        source: "config-file",
      });
    });
    expect(strip().className).toBe("tab-strip tab-strip--vertical");
    expect(stripVar("--tab-rail-width")).toBe(""); // back to the CSS-owned 180px rail

    // Keep-alive across both flips: same host node, zero TerminalView unmounts.
    expect(screen.getByTestId("tab-host-1")).toBe(host1);
    expect(recorder.unmounts).toBe(unmountsBefore);
  });

  it("junk settings:changed payloads for the new key are inert", async () => {
    makeSettingsStore().set("tabs.barPosition", "left");
    const { settingsChanged } = renderApp();
    await act(async () => {
      settingsChanged.fire({ key: "tabs.sideLabelOrientation", value: "diagonal", source: "config-file" });
      settingsChanged.fire({ key: "tabs.sideLabelOrientation", value: 7, source: "config-file" });
      settingsChanged.fire({ key: "appearance.theme", value: "vertical", source: "config-file" });
    });
    expect(strip().className).toBe("tab-strip tab-strip--vertical");
    expect(stripVar("--tab-rail-width")).toBe("");
  });

  it("a live position change to top/bottom drops the vertical labels (the gate re-applies)", async () => {
    makeSettingsStore().set("tabs.barPosition", "left");
    makeSettingsStore().set("tabs.sideLabelOrientation", "vertical");
    const { settingsChanged } = renderApp();
    expect(strip().className).toBe("tab-strip tab-strip--vertical tab-strip--labels-vertical");

    await act(async () => {
      settingsChanged.fire({ key: "tabs.barPosition", value: "bottom", source: "settings-window" });
    });
    expect(strip().className).toBe("tab-strip");
    expect(stripVar("--tab-rail-width")).toBe(""); // status quo (CSS-owned) — the setting stays latent

    // Back to a side edge: the latent vertical setting re-engages without another broadcast.
    await act(async () => {
      settingsChanged.fire({ key: "tabs.barPosition", value: "right", source: "settings-window" });
    });
    expect(strip().className).toBe("tab-strip tab-strip--vertical tab-strip--labels-vertical");
    expect(stripVar("--tab-rail-width")).toBe("44px");
  });
});

// trmx-84 (FR-3.1/3.2): split panes. A tab owns a pane TREE; App renders each leaf as an
// absolutely-positioned, paneId-keyed sibling host. The load-bearing invariant: a split/close only
// re-lays-out (mutates style) — it never remounts a SURVIVING pane's terminal (recorder.unmounts
// stays put for survivors), so PTY sessions live across re-layout. ⌘D/⇧⌘D and the split-right/
// split-below menu verbs both drive it; ⌘W is pane → tab → window.
describe("App split panes (trmx-84)", () => {
  const cmdD = (shift = false) =>
    fireEvent.keyDown(document.body, { key: "d", metaKey: true, shiftKey: shift });

  it("⌘D splits the focused pane WITHOUT remounting the existing pane (keep-alive)", async () => {
    const { attach, calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    const host1 = screen.getByTestId("pane-host-1");
    expect(recorder.mounts).toHaveLength(1);

    cmdD(); // Split Right

    // Two pane hosts now; the ORIGINAL pane host is the SAME DOM node (never reparented).
    expect(screen.getByTestId("pane-host-1")).toBe(host1);
    expect(screen.getByTestId("pane-host-2")).toBeInTheDocument();
    expect(recorder.unmounts).toBe(0); // the survivor never unmounted
    expect(recorder.mounts).toHaveLength(2); // the new pane mounted once
    expect(attach).toHaveBeenCalledTimes(2); // the new pane opened its own PTY
    // A row split renders a (static) vertical divider.
    expect(screen.getByTestId("pane-divider-root")).toBeInTheDocument();
    // The new pane takes focus.
    expect(screen.getByTestId("pane-host-2").className).toContain("pane-host--focused");
    expect(screen.getByTestId("pane-host-1").className).not.toContain("pane-host--focused");
  });

  it("drives split from the split-right / split-below menu verbs (tabs:action)", async () => {
    const { calls, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });

    await act(async () => tabsAction.fire("split-right"));
    expect(screen.getByTestId("pane-host-2")).toBeInTheDocument();
    expect(screen.getByTestId("pane-divider-root").className).toContain("pane-divider--row");

    // split-below nests under the now-focused pane 2 → a column divider appears.
    await act(async () => tabsAction.fire("split-below"));
    expect(screen.getByTestId("pane-host-3")).toBeInTheDocument();
    expect(recorder.unmounts).toBe(0); // still zero across a second re-layout
    const dividers = screen.getAllByTestId(/^pane-divider-/);
    expect(dividers.some((d) => d.className.includes("pane-divider--column"))).toBe(true);
  });

  it("a new pane inherits the FOCUSED pane's OSC-7 cwd", () => {
    const { attach } = renderApp();
    // Prime the boot (focused) pane's cwd the way an OSC 7 report would.
    recorder.mounts[0].cwdStore?.set("/tmp");

    cmdD(); // split — the new pane opens with the focused pane's cwd

    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach.mock.calls[0][1]).toEqual({ cwd: undefined }); // boot pane inherited nothing
    expect(attach.mock.calls[1][1]).toEqual({ cwd: "/tmp" }); // the split pane did
    // Each pane got its OWN store (per-pane isolation).
    expect(recorder.mounts[1].cwdStore).toBeDefined();
    expect(recorder.mounts[1].cwdStore).not.toBe(recorder.mounts[0].cwdStore);
  });

  it("closing the focused pane (⌘W) disposes ONLY its PTY; the sibling never remounts", async () => {
    const { calls, closeSession, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    cmdD(); // split → pane 2 focused
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });
    const host1 = screen.getByTestId("pane-host-1");
    const unmountsBefore = recorder.unmounts;

    await act(async () => tabsAction.fire("close")); // ⌘W closes the focused pane (2)

    expect(closeSession).toHaveBeenCalledExactlyOnceWith(22); // only the closed pane's session
    expect(screen.queryByTestId("pane-host-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("pane-host-1")).toBe(host1); // survivor's host node unchanged
    expect(recorder.unmounts).toBe(unmountsBefore + 1); // exactly the closed pane unmounted
    expect(screen.getByTestId("tab-1")).toBeInTheDocument(); // the tab survives (still 1 pane)
    // Focus fell back to the surviving pane.
    expect(screen.getByTestId("pane-host-1").className).toContain("pane-host--focused");
  });

  it("⌘W precedence is pane → tab → window", async () => {
    const { calls, closeWindow, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    cmdD(); // one tab, two panes (1 | 2), focus 2

    // 1) pane: closing the focused pane leaves the tab open.
    await act(async () => tabsAction.fire("close"));
    expect(screen.getByTestId("tab-1")).toBeInTheDocument();
    expect(screen.queryByTestId("pane-host-2")).not.toBeInTheDocument();
    expect(closeWindow).not.toHaveBeenCalled();

    // 2) tab → window: now the tab has one pane and is the only tab, so ⌘W closes the WINDOW.
    await act(async () => tabsAction.fire("close"));
    expect(closeWindow).toHaveBeenCalledTimes(1);
  });

  it("the tab label + window title follow the FOCUSED pane; a background pane is isolated", async () => {
    const { calls, setWindowTitle } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    cmdD(); // split → pane 2 focused
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("two"); // focused pane 2
    expect(setWindowTitle).toHaveBeenLastCalledWith("two");

    // Pane 1 is in the background: its OSC title updates its own state but NOT the tab/window title.
    await act(async () => recorder.mounts[0].onOscTitle?.("vim"));
    expect(screen.getByTestId("tab-1")).toHaveTextContent("two");
    expect(setWindowTitle).not.toHaveBeenLastCalledWith("vim");

    // Click-to-focus pane 1 → the label + window title switch to its title.
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("pane-host-1"));
    });
    expect(screen.getByTestId("pane-host-1").className).toContain("pane-host--focused");
    expect(screen.getByTestId("tab-1")).toHaveTextContent("vim");
    expect(setWindowTitle).toHaveBeenLastCalledWith("vim");
  });

  it("⇧⌘D splits below (a column divider)", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    cmdD(true); // Split Below
    expect(screen.getByTestId("pane-host-2")).toBeInTheDocument();
    expect(screen.getByTestId("pane-divider-root").className).toContain("pane-divider--column");
  });

  it("rename targets the FOCUSED pane's manual title (multi-pane)", async () => {
    const { calls, mirrorTitle, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    cmdD(); // split → pane 2 focused
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });

    await act(async () => tabsAction.fire("rename"));
    const input = screen.getByTestId("tab-rename-input") as HTMLInputElement;
    expect(input.value).toBe("two"); // the focused pane's title
    fireEvent.change(input, { target: { value: "deploy" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByTestId("tab-1")).toHaveTextContent("deploy");
    expect(mirrorTitle).toHaveBeenCalledWith(22, "deploy"); // mirrored to the FOCUSED pane's session
    // Focus a different pane → its (unrenamed) title shows, proving the rename was pane-scoped.
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("pane-host-1"));
    });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("one");
  });

  it("split cwd inheritance is FOCUSED-pane-scoped, not tab-scoped", async () => {
    const { attach, calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    recorder.mounts[0].cwdStore?.set("/home"); // pane 1's cwd
    cmdD(); // split → pane 2 focused
    await resolveAttach(calls[1], { sessionId: 2, title: "two" });
    recorder.mounts[1].cwdStore?.set("/var"); // pane 2's cwd (currently focused)

    // Focus pane 1, then split from it: the new pane inherits pane 1's cwd, NOT the last-focused one.
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("pane-host-1"));
    });
    cmdD();
    expect(attach).toHaveBeenCalledTimes(3);
    expect(attach.mock.calls[2][1]).toEqual({ cwd: "/home" });
  });

  it("a pty:exited for ONE pane in a split tab closes only that pane (paneBySessionId routing)", async () => {
    const { calls, closeSession, ptyExited } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    cmdD(); // split → pane 2 focused
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });
    const host1 = screen.getByTestId("pane-host-1");

    await act(async () => ptyExited.fire(22)); // pane 2's shell exits

    expect(screen.queryByTestId("pane-host-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("pane-host-1")).toBe(host1); // survivor host is identical
    expect(screen.getByTestId("tab-1")).toBeInTheDocument(); // the tab (with pane 1) survives
    expect(closeSession).not.toHaveBeenCalled(); // already exited — no redundant close_pty
    expect(screen.getByTestId("pane-host-1").className).toContain("pane-host--focused");
  });

  it("a pane dying mid-rename (pty:exited) clears the rename so it can't re-target the survivor", async () => {
    const { calls, tabsAction, ptyExited } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    cmdD(); // split → pane 2 focused
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });

    await act(async () => tabsAction.fire("rename")); // rename the focused pane (2)
    expect(screen.getByTestId("tab-rename-input")).toBeInTheDocument();

    await act(async () => ptyExited.fire(22)); // the renamed (focused) pane's shell exits

    // The input died with its pane; rename state cleared, the survivor is focused (a stuck
    // renamingTabId would let a later commit re-target the survivor).
    expect(screen.queryByTestId("tab-rename-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pane-host-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("pane-host-1").className).toContain("pane-host--focused");
  });
});

// trmx-85 (FR-3.3): divider drag-resize. Dragging a divider maps the pointer → a clamped ratio for
// that split (dividerDrag.ts), dispatched one setPaneRatio per animation frame; a drag overlay +
// setPointerCapture shield the terminals; double-click resets to 50/50. Geometry: an 800px content
// area split once puts the divider leading edge at x=400 (pane 1 = 400px wide).
describe("App divider drag (trmx-85)", () => {
  const cmdD = () => fireEvent.keyDown(document.body, { key: "d", metaKey: true });
  const paneW = (id: number) => Number.parseInt(screen.getByTestId(`pane-host-${id}`).style.width, 10);

  async function splitOnce(ctx: ReturnType<typeof renderApp>) {
    await resolveAttach(ctx.calls[0], { sessionId: 1, title: "one" });
    cmdD(); // pane 1 | pane 2; divider "root" at x≈400
    return screen.getByTestId("pane-divider-root");
  }

  it("drag resizes the split, coalesced to one dispatch per frame, keep-alive held", async () => {
    const ctx = renderApp();
    const divider = await splitOnce(ctx);
    expect(paneW(1)).toBe(400);

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 200, clientY: 300 }); // same frame
    expect(ctx.frame.scheduleCalls).toBe(1); // two moves coalesced into ONE frame
    await act(async () => ctx.frame.flush());

    expect(paneW(1)).toBeLessThanOrEqual(210); // followed the pointer to ~200
    expect(paneW(2)).toBeGreaterThan(400); // the sibling grew
    expect(recorder.unmounts).toBe(0); // no terminal remounted across the drag
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 200, clientY: 300 });
  });

  it("does NOT jump the divider when the grab landed beside the 1px line (grab offset)", async () => {
    const ctx = renderApp();
    const divider = await splitOnce(ctx);
    // Grab 3px to the right of the visual line (still inside the widened hit area).
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 403, clientY: 300, button: 0 });
    // A move with the pointer STILL at 403 must keep the divider at 400 (no snap to 403).
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 403, clientY: 300 });
    await act(async () => ctx.frame.flush());
    expect(paneW(1)).toBe(400); // unchanged — no jump
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 403, clientY: 300 });
  });

  it("shows the drag overlay only during a drag, with the right cursor class", async () => {
    const ctx = renderApp();
    const divider = await splitOnce(ctx);
    expect(screen.queryByTestId("pane-drag-overlay")).not.toBeInTheDocument();

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    expect(screen.getByTestId("pane-drag-overlay").className).toContain("pane-drag-overlay--row");

    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 400, clientY: 300 });
    expect(screen.queryByTestId("pane-drag-overlay")).not.toBeInTheDocument();
  });

  it("double-click resets the split to 50/50", async () => {
    const ctx = renderApp();
    const divider = await splitOnce(ctx);
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 200, clientY: 300 });
    await act(async () => ctx.frame.flush());
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 200, clientY: 300 });
    expect(paneW(1)).toBeLessThan(300);

    await act(async () => fireEvent.doubleClick(screen.getByTestId("pane-divider-root")));
    expect(paneW(1)).toBe(400); // back to half
  });

  it("pointerup COMMITS the final drag position even if the frame never fired (no lost release)", async () => {
    const ctx = renderApp();
    const divider = await splitOnce(ctx);
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 200, clientY: 300 }); // queues a frame
    // Release BEFORE flushing the frame — a quick drag-and-release must STILL apply the final position.
    await act(async () => {
      fireEvent.pointerUp(divider, { pointerId: 1, clientX: 200, clientY: 300 });
    });
    expect(ctx.frame.hasPending()).toBe(false); // the frame was cancelled (no double dispatch)
    expect(paneW(1)).toBeLessThanOrEqual(210); // the drag to ~200 WAS committed on release
    await act(async () => ctx.frame.flush()); // a later flush is a no-op
    expect(paneW(1)).toBeLessThanOrEqual(210);
  });

  it("pointercancel ABORTS the drag (no commit) and removes the overlay", async () => {
    const ctx = renderApp();
    const divider = await splitOnce(ctx);
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 200, clientY: 300 }); // would move to ~200
    expect(screen.getByTestId("pane-drag-overlay")).toBeInTheDocument();
    await act(async () => {
      fireEvent.pointerCancel(divider, { pointerId: 1, clientX: 200, clientY: 300 });
    });
    expect(screen.queryByTestId("pane-drag-overlay")).not.toBeInTheDocument();
    expect(ctx.frame.hasPending()).toBe(false);
    expect(paneW(1)).toBe(400); // aborted — the pending position was NOT committed
  });

  it("lostpointercapture aborts the drag; a nested/column divider drags its own split; content offset respected", async () => {
    const ctx = renderApp();
    const divider = await splitOnce(ctx); // panes 1 | 2 (row divider "root")
    // lostpointercapture aborts like pointercancel.
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 250, clientY: 300 });
    fireEvent.lostPointerCapture(divider, { pointerId: 1 });
    expect(ctx.frame.hasPending()).toBe(false);
    expect(paneW(1)).toBe(400); // aborted

    // Split pane 2 BELOW → a nested column divider; dragging it must change only that split.
    fireEvent.keyDown(document.body, { key: "d", metaKey: true, shiftKey: true }); // ⇧⌘D on focused pane 2
    const p1Before = paneW(1);
    const colDivider = screen.getByTestId("pane-divider-second"); // the nested split under the root's "second"
    fireEvent.pointerDown(colDivider, { pointerId: 2, clientX: 600, clientY: 300, button: 0 });
    fireEvent.pointerMove(colDivider, { pointerId: 2, clientX: 600, clientY: 150 }); // drag the column divider up
    await act(async () => ctx.frame.flush());
    fireEvent.pointerUp(colDivider, { pointerId: 2, clientX: 600, clientY: 150 });
    // Pane 1 (in the ROOT split, untouched by the nested column drag) keeps its width.
    expect(paneW(1)).toBe(p1Before);
  });

  it("maps the pointer through a NON-ZERO content-area offset (subtracts contentRect.left)", async () => {
    const ctx = renderApp();
    const divider = await splitOnce(ctx);
    // Place the content area (.tab-hosts) at viewport (100,50): a content-x of 400 is viewport-x 500.
    const hosts = ctx.view.container.querySelector(".tab-hosts")!;
    hosts.getBoundingClientRect = () =>
      ({ left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect;
    // Grab the divider (viewport 500 = content 400, offset 0), drag to viewport 300 (= content 200).
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500, clientY: 350, button: 0 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 300, clientY: 350 });
    await act(async () => ctx.frame.flush());
    // If the offset were NOT subtracted, content-x would be 300 (pane ~300); it is 200 (pane ~200).
    expect(paneW(1)).toBeLessThanOrEqual(210);
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 300, clientY: 350 });
  });

  it("unmounting mid-drag cancels the pending frame (no dispatch into a dead reducer)", async () => {
    const ctx = renderApp();
    const divider = await splitOnce(ctx);
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 200, clientY: 300 }); // queues a frame
    expect(ctx.frame.hasPending()).toBe(true);
    ctx.view.unmount();
    expect(ctx.frame.hasPending()).toBe(false); // the unmount cleanup cancelled it
    expect(() => ctx.frame.flush()).not.toThrow(); // flushing after unmount is a safe no-op
  });
});

// trmx-86 (FR-3.5): keyboard pane navigation. ⌥⌘-arrows move focus geometrically; ⌘]/⌘[ cycle; the
// Window-menu verbs do the same. Nav chords are consumed from xterm (stopImmediatePropagation) even at
// an edge no-op. A 2×2 grid is ((1/3) | (2/4)): 1 top-left, 3 bottom-left, 2 top-right, 4 bottom-right.
describe("App pane navigation (trmx-86)", () => {
  const focused = (id: number) => screen.getByTestId(`pane-host-${id}`).className.includes("pane-host--focused");
  const key = (k: string, mods: Record<string, boolean> = {}) =>
    fireEvent.keyDown(document.body, { key: k, metaKey: true, ...mods });

  async function grid2x2(ctx: ReturnType<typeof renderApp>) {
    await resolveAttach(ctx.calls[0], { sessionId: 1, title: "one" });
    key("d"); // ⌘D → pane 2 (focus 2)
    fireEvent.mouseDown(screen.getByTestId("pane-host-1")); // focus 1
    key("d", { shiftKey: true }); // ⇧⌘D split pane 1 below → pane 3 (focus 3)
    fireEvent.mouseDown(screen.getByTestId("pane-host-2")); // focus 2
    key("d", { shiftKey: true }); // ⇧⌘D split pane 2 below → pane 4 (focus 4)
    expect(focused(4)).toBe(true);
  }

  it("⌥⌘-arrows move focus geometrically in a 2×2 grid", async () => {
    const ctx = renderApp();
    await grid2x2(ctx); // focus = pane 4 (bottom-right)
    key("ArrowLeft", { altKey: true }); // → bottom-left (3)
    expect(focused(3)).toBe(true);
    key("ArrowUp", { altKey: true }); // → top-left (1)
    expect(focused(1)).toBe(true);
    key("ArrowRight", { altKey: true }); // → top-right (2)
    expect(focused(2)).toBe(true);
  });

  it("⌘] / ⌘[ cycle focus over the leaves order (wrapping)", async () => {
    const ctx = renderApp();
    await grid2x2(ctx); // leaves order 1,3,2,4; focus 4
    key("]"); // 4 → 1 (wrap)
    expect(focused(1)).toBe(true);
    key("]"); // 1 → 3
    expect(focused(3)).toBe(true);
    key("["); // 3 → 1
    expect(focused(1)).toBe(true);
  });

  it("Window-menu pane verbs move focus the same way", async () => {
    const ctx = renderApp();
    await grid2x2(ctx); // focus 4
    await act(async () => ctx.tabsAction.fire("pane-left")); // → 3
    expect(focused(3)).toBe(true);
    await act(async () => ctx.tabsAction.fire("pane-next")); // leaves cycle 3 → 2
    expect(focused(2)).toBe(true);
  });

  it("an edge nav is a no-op but STILL consumes the key (no PTY leak)", async () => {
    const ctx = renderApp();
    await grid2x2(ctx);
    fireEvent.mouseDown(screen.getByTestId("pane-host-1")); // focus top-left
    expect(focused(1)).toBe(true);
    // ⌥⌘← at the left edge: no pane to the left → focus unchanged, but the event is consumed.
    const ev = new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, altKey: true, bubbles: true, cancelable: true });
    const stop = vi.spyOn(ev, "stopImmediatePropagation");
    document.body.dispatchEvent(ev);
    expect(focused(1)).toBe(true); // no-op
    expect(stop).toHaveBeenCalled(); // consumed — xterm never sees it
    expect(ev.defaultPrevented).toBe(true);
  });

  it("nav chords are inert while a rename input is focused", async () => {
    const ctx = renderApp();
    await grid2x2(ctx); // focus 4
    await act(async () => ctx.tabsAction.fire("rename"));
    const input = screen.getByTestId("tab-rename-input");
    fireEvent.keyDown(input, { key: "ArrowLeft", metaKey: true, altKey: true });
    expect(focused(4)).toBe(true); // focus unchanged — the input (non-terminal editable) owns the key
    expect(screen.getByTestId("tab-rename-input")).toBeInTheDocument();
  });
});

// trmx-87 (FR-3.6): the Kitty multi-pane look. The dividers OUTLINING the focused pane render with
// `pane-divider--active`, the rest `--inactive`; a focus flip moves the active class WITHOUT remounting
// a terminal; a single-pane tab has no divider (baseline). Divider testids: root / first / second.
describe("App multi-pane chrome (trmx-87)", () => {
  const cls = (testid: string) => screen.getByTestId(testid).className;

  async function grid2x2(ctx: ReturnType<typeof renderApp>) {
    await resolveAttach(ctx.calls[0], { sessionId: 1, title: "one" });
    fireEvent.keyDown(document.body, { key: "d", metaKey: true }); // ⌘D → pane 2 (focus 2)
    fireEvent.mouseDown(screen.getByTestId("pane-host-1")); // focus 1
    fireEvent.keyDown(document.body, { key: "d", metaKey: true, shiftKey: true }); // ⇧⌘D → pane 3
    fireEvent.mouseDown(screen.getByTestId("pane-host-2")); // focus 2
    fireEvent.keyDown(document.body, { key: "d", metaKey: true, shiftKey: true }); // ⇧⌘D → pane 4 (focus 4)
  }

  it("outlines the FOCUSED pane's dividers as active; the rest inactive", async () => {
    const ctx = renderApp();
    await grid2x2(ctx); // focus = pane 4 (bottom-right): active = root + right-column ("second")
    expect(cls("pane-divider-root")).toContain("pane-divider--active");
    expect(cls("pane-divider-second")).toContain("pane-divider--active");
    expect(cls("pane-divider-first")).toContain("pane-divider--inactive"); // left column doesn't bound 4
  });

  it("a focus flip moves the active chrome WITHOUT remounting a terminal (style-only)", async () => {
    const ctx = renderApp();
    await grid2x2(ctx); // focus 4
    const unmountsBefore = recorder.unmounts;
    fireEvent.mouseDown(screen.getByTestId("pane-host-1")); // focus top-left (1): active = root + "first"
    expect(cls("pane-divider-first")).toContain("pane-divider--active");
    expect(cls("pane-divider-second")).toContain("pane-divider--inactive");
    expect(recorder.unmounts).toBe(unmountsBefore); // re-chrome is a class flip, not a re-layout
  });

  it("a single-pane tab renders NO divider and its pane is focused (baseline, not dimmed)", async () => {
    const ctx = renderApp();
    await resolveAttach(ctx.calls[0], { sessionId: 1, title: "one" });
    expect(screen.queryByTestId("pane-divider-root")).not.toBeInTheDocument();
    // The dim is CSS `.pane-host:not(.pane-host--focused)`; the only pane is focused, so it is never dimmed.
    expect(screen.getByTestId("pane-host-1").className).toContain("pane-host--focused");
  });
});
