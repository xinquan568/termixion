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

function renderApp(opts: { strict?: boolean } = {}) {
  const { attach, calls } = makeAttach();
  const closeWindow = vi.fn();
  const closeSession = vi.fn(() => Promise.resolve());
  const tabsAction = makeObservation<unknown>();
  const ptyExited = makeObservation<number>();
  const titleHint = makeHintObservation();
  const setWindowTitle = vi.fn();
  const mirrorTitle = vi.fn(() => Promise.resolve());
  const props: AppProps = {
    attach,
    closeWindow,
    closeSession,
    observeTabsAction: tabsAction.observe,
    observePtyExited: ptyExited.observe,
    observeTitleHint: titleHint.observe,
    setWindowTitle,
    mirrorTitle,
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
    setWindowTitle,
    mirrorTitle,
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
