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
import { render, screen, fireEvent, act, within } from "@testing-library/react";
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
    handle: { terminal: { focus: () => void; clearSelection: () => void } };
    cwdStore: { get(): string | null; set(cwd: string): void } | undefined;
    onOscTitle: ((title: string) => void) | undefined;
    onBadge: ((badge: string | null) => void) | undefined;
    onPromptMarker: ((t: { kind: string; busy: boolean; busyChanged: boolean; exitCode?: number }) => void) | undefined;
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
      onBadge,
      onPromptMarker,
    }: {
      onReady?: (handle: unknown) => void;
      cwdStore?: { get(): string | null; set(cwd: string): void };
      onOscTitle?: (title: string) => void;
      onBadge?: (badge: string | null) => void;
      onPromptMarker?: (t: { kind: string; busy: boolean; busyChanged: boolean; exitCode?: number }) => void;
    }) => {
      useEffect(() => {
        const handle = {
          terminal: { focus: vi.fn(), clearSelection: vi.fn() },
          renderer: "dom",
          fit: () => {},
          dispose: () => {},
        };
        recorder.mounts.push({ handle, cwdStore, onOscTitle, onBadge, onPromptMarker });
        onReady?.(handle);
        return () => {
          recorder.unmounts += 1;
        };
        // The real TerminalView remounts when these identities change — mirroring that makes the
        // keep-alive test honest: an unstable onReady/cwdStore/onOscTitle/onBadge/onPromptMarker from App
        // would count an unmount (trmx-75/90/99: the per-pane OSC callbacks must be cached like onReady).
      }, [onReady, cwdStore, onOscTitle, onBadge, onPromptMarker]);
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
import { clearUserThemes, registerUserThemes } from "./theme/registry";
import { night } from "./theme/themes/night";
import type { ThemeSpec } from "./theme/themeDerive";

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

// The session:activity seam carries (sessionId, busy, meta?) — same capture pattern (trmx-91/159).
type ActivityMetaArg = { name?: string; args?: string[]; stdinTty?: boolean };
function makeActivityObservation() {
  let handler:
    | ((sessionId: number, busy: boolean, meta?: ActivityMetaArg) => void)
    | undefined;
  const teardown = vi.fn();
  const observe = vi.fn(
    (h: (sessionId: number, busy: boolean, meta?: ActivityMetaArg) => void) => {
      handler = h;
      return teardown;
    },
  );
  return {
    observe,
    teardown,
    fire: (sessionId: number, busy: boolean, meta?: ActivityMetaArg) =>
      handler?.(sessionId, busy, meta),
  };
}

// trmx-159: the test-only PTY output-length + keystroke-input seams (production wires these through
// useBackend's live terminal). Same capture pattern.
function makeOutputObservation() {
  let handler: ((sessionId: number, byteLength: number) => void) | undefined;
  const observe = vi.fn((h: (sessionId: number, byteLength: number) => void) => {
    handler = h;
    return vi.fn();
  });
  return { observe, fire: (sessionId: number, byteLength: number) => handler?.(sessionId, byteLength) };
}
function makeInputObservation() {
  let handler: ((sessionId: number, data: string) => void) | undefined;
  const observe = vi.fn((h: (sessionId: number, data: string) => void) => {
    handler = h;
    return vi.fn();
  });
  return { observe, fire: (sessionId: number, data: string) => handler?.(sessionId, data) };
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

function renderApp(opts: { strict?: boolean; invoke?: AppProps["invoke"] } = {}) {
  const { attach, calls } = makeAttach();
  const frame = makeFrameSchedule();
  const closeWindow = vi.fn();
  const closeSession = vi.fn(() => Promise.resolve());
  const tabsAction = makeObservation<unknown>();
  const ptyExited = makeObservation<number>();
  const titleHint = makeHintObservation();
  const activity = makeActivityObservation(); // trmx-91: session:activity broadcasts
  const output = makeOutputObservation(); // trmx-159: PTY output-length observations
  const input = makeInputObservation(); // trmx-159: keystroke-input observations
  const settingsChanged = makeObservation<unknown>(); // trmx-81: settings:changed broadcasts
  const setWindowTitle = vi.fn();
  const mirrorTitle = vi.fn(() => Promise.resolve());
  // trmx-89: the themes hot-reload installer seam — a no-op returning a teardown spy keeps these
  // tests backend-free (the real installer subscribes to the Tauri themes:changed bus).
  const hotReloadTeardown = vi.fn();
  const installHotReload = vi.fn().mockReturnValue(hotReloadTeardown);
  const props: AppProps = {
    attach,
    closeWindow,
    closeSession,
    observeTabsAction: tabsAction.observe,
    observePtyExited: ptyExited.observe,
    observeTitleHint: titleHint.observe,
    observeActivity: activity.observe,
    observeOutput: output.observe,
    observeInput: input.observe,
    observeSettings: settingsChanged.observe,
    setWindowTitle,
    mirrorTitle,
    dragSchedule: frame.schedule,
    installHotReload,
    // trmx-151: injectable backend invoke (keys_read drives the keymap rebuild); undefined keeps
    // App's realInvoke default (which rejects in jsdom → the shipped default keymap).
    invoke: opts.invoke,
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
    activity,
    output,
    input,
    settingsChanged,
    setWindowTitle,
    mirrorTitle,
    frame,
    installHotReload,
    hotReloadTeardown,
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

// trmx-188: the app-drawn title bar consumes the SAME active-tab derived title the native window
// title gets (App passes activeTab.title down — the component never re-derives). Structure pin:
// the bar is the FIRST child of main.app, ABOVE the app-body wrapper that carries the trmx-81
// direction-flipping flex (so the bar tops the window for every tabs.barPosition).
describe("App title bar (trmx-188)", () => {
  async function twoTabs() {
    const ctx = renderApp();
    await resolveAttach(ctx.calls[0], { sessionId: 11, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(ctx.calls[1], { sessionId: 22, title: "two" });
    return ctx;
  }

  it("is the first child of main.app, above the app-body wrapper", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    const main = document.querySelector("main.app")!;
    expect(main.firstElementChild?.className).toContain("title-bar");
    expect(main.querySelector(".app-body")).not.toBeNull();
    // The hosts + strip moved INSIDE app-body (the direction-flipping container).
    expect(main.querySelector(".app-body .tab-hosts")).not.toBeNull();
    expect(main.querySelector('.app-body [data-testid="tab-strip"]')).not.toBeNull();
  });

  it("shows the ACTIVE tab's derived title and follows switches", async () => {
    await twoTabs();
    const barTitle = () => document.querySelector(".title-bar__title")!.textContent;
    expect(barTitle()).toBe("two");

    clickTab(1);
    expect(barTitle()).toBe("one");
    clickTab(2);
    expect(barTitle()).toBe("two");
  });

  it("a background tab's OSC title never reaches the bar", async () => {
    await twoTabs();
    await act(async () => {
      recorder.mounts[0].onOscTitle?.("secret build"); // tab 1 is hidden behind tab 2
    });
    expect(document.querySelector(".title-bar__title")!.textContent).toBe("two");
  });
});

// trmx-190: the AI-session counter in the title bar's right slot. The counter derives from
// PaneState.foreground (set on the poller's busy RISE metadata, cleared on the fall, corrected by
// the 1 Hz hint) + activityVisible (the NUMERATOR INVARIANT: numerator == lit activity bars).
// These are the behavioral tests e2e cannot reach (no Tauri runtime there): live updates through
// the injected seams, the invariant end-to-end, foreground lifecycle, and click-to-cycle focus.
describe("App AI-session counter (trmx-190)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const counter = () => screen.queryByTestId("ai-counter");
  const segment = (bucket: string) =>
    counter()?.querySelector(`[data-bucket="${bucket}"]`)?.textContent;

  it("a rise with AI metadata shows the total at once; the lit activity bar raises the numerator (the invariant)", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    expect(counter()).not.toBeInTheDocument(); // no AI sessions → renders nothing
    vi.useFakeTimers();

    // claude in a PLAIN shape (a positional) — the light gates on the 150ms debounce only.
    act(() => activity.fire(7, true, { name: "claude", args: ["task.md"], stdinTty: true }));
    expect(segment("claude")).toBe("claude: 0/1"); // total immediate (the 250ms path), not yet active
    act(() => vi.advanceTimersByTime(150)); // the activity bar lights...
    expect(segment("claude")).toBe("claude: 1/1"); // ...and the numerator follows it exactly

    // All is suppressed with a single visible bucket (redundant).
    const all = counter()!.querySelector('[data-bucket="All"]');
    expect(all?.className ?? "").toContain("ai-counter__segment--redundant");
  });

  it("the busy fall clears the foreground — quitting the AI drops the counter entirely", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    act(() => activity.fire(7, true, { name: "codex", args: ["x"], stdinTty: true }));
    expect(segment("codex")).toBe("codex: 0/1");
    act(() => activity.fire(7, false));
    expect(counter()).not.toBeInTheDocument();
  });

  it("a 1 Hz title hint corrects a missed rise (and a shell hint corrects it back)", async () => {
    const { calls, titleHint } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    act(() => titleHint.fire(7, "codex"));
    expect(segment("codex")).toBe("codex: 0/1");
    act(() => titleHint.fire(7, "zsh"));
    expect(counter()).not.toBeInTheDocument(); // zsh buckets to null — not an AI session
  });

  it("an OSC-133-owned pane still tracks foreground from the poller's rise (counting is carve-out-independent)", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    const marker = recorder.mounts[0].onPromptMarker!;
    act(() => marker({ kind: "C", busy: true, busyChanged: true })); // latch OSC-133 ownership
    act(() => activity.fire(7, true, { name: "claude" })); // rawBusy ignored — foreground is not
    expect(segment("claude")).toBe("claude: 0/1");
  });

  it("click cycles focus through the AI panes of ONE tab — focusPane, not just activateTab", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    fireEvent.keyDown(document.body, { key: "d", metaKey: true }); // ⌘D split → pane 2, focused
    await resolveAttach(calls[1], { sessionId: 8, title: "zsh" });
    vi.useFakeTimers();
    act(() => activity.fire(7, true, { name: "claude", args: ["a"], stdinTty: true }));
    act(() => activity.fire(8, true, { name: "claude", args: ["b"], stdinTty: true }));
    act(() => vi.advanceTimersByTime(150)); // both lit → both in the active cycle
    expect(segment("claude")).toBe("claude: 2/2");
    expect(screen.getByTestId("pane-host-2").className).toContain("pane-host--focused");

    fireEvent.click(counter()!); // first active in tab order → pane 1
    expect(screen.getByTestId("pane-host-1").className).toContain("pane-host--focused");
    fireEvent.click(counter()!); // next → pane 2
    expect(screen.getByTestId("pane-host-2").className).toContain("pane-host--focused");
    fireEvent.click(counter()!); // wrap-around → pane 1 again
    expect(screen.getByTestId("pane-host-1").className).toContain("pane-host--focused");
  });

  it("click activates the OTHER tab when the next AI session lives there (activateTab)", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 8, title: "two" });
    // Tab 2 is active; the only AI session lives in tab 1 (idle → the fallback-all cycle).
    act(() => activity.fire(7, true, { name: "codex", args: ["x"], stdinTty: true }));
    expect(screen.getByTestId("tab-2").className).toContain(activeClass);
    fireEvent.click(counter()!);
    expect(screen.getByTestId("tab-1").className).toContain(activeClass);
    expect(screen.getByTestId("pane-host-1").className).toContain("pane-host--focused");
  });

  it("titleBar.aiCounter OFF hides the counter (a pure render gate)", async () => {
    const { calls, activity, settingsChanged } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    act(() => activity.fire(7, true, { name: "claude", args: ["x"], stdinTty: true }));
    expect(counter()).toBeInTheDocument();
    await act(async () => {
      settingsChanged.fire({ key: "titleBar.aiCounter", value: false, source: "settings-window" });
    });
    expect(counter()).not.toBeInTheDocument();
    await act(async () => {
      settingsChanged.fire({ key: "titleBar.aiCounter", value: true, source: "config-file" });
    });
    expect(counter()).toBeInTheDocument();
  });

  it("the tooltip lists each AI session with its title and active state", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "build box" });
    act(() => activity.fire(7, true, { name: "claude", args: ["x"], stdinTty: true }));
    const tooltip = screen.getByTestId("ai-counter-tooltip");
    expect(tooltip.textContent).toContain("build box");
    expect(tooltip.textContent).toContain("claude");
  });
});

// trmx-191: the ⌘⇧A manual activity toggle — a one-shot override on the focused pane. Direction
// derives from the RENDERED state (lightActive OR the trmx-99 flash), force-off clears the flash,
// the override auto-clears on the next genuine detector event, and the trmx-190 counter numerator
// moves in the same interaction (the shared invariant both issues pinned).
describe("App activity toggle (trmx-191)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const barIn = (paneId: number) =>
    within(screen.getByTestId(`pane-host-${paneId}`)).queryByTestId("pane-activity");
  const chord = () =>
    fireEvent.keyDown(document.body, { key: "a", metaKey: true, shiftKey: true });

  it("⌘⇧A force-shows a hidden bar and force-hides it again on the focused pane", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    expect(barIn(1)).not.toBeInTheDocument();
    chord();
    expect(barIn(1)).toBeInTheDocument(); // forced on, no detector involved
    chord();
    expect(barIn(1)).not.toBeInTheDocument(); // rendered-active → forced off
  });

  it("a flash-only stuck bar toggles OFF (not on) and the flash clears", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    const marker = recorder.mounts[0].onPromptMarker!;
    // A failed command's exit flash: D;1 with no busy state — the bar shows on the flash leg only.
    act(() => marker({ kind: "D", busy: false, busyChanged: false, exitCode: 1 }));
    expect(barIn(1)).toBeInTheDocument();
    chord();
    // The rendered-state direction rule: visible (via flash) → force OFF + clearFlash, not force on.
    expect(barIn(1)).not.toBeInTheDocument();
  });

  it("acts on the FOCUSED pane only — a background pane's bar is untouched", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    fireEvent.keyDown(document.body, { key: "d", metaKey: true }); // split → pane 2 focused
    await resolveAttach(calls[1], { sessionId: 8, title: "zsh" });
    vi.useFakeTimers();
    act(() => activity.fire(7, true, { name: "sleep" })); // background pane 1 busy
    act(() => vi.advanceTimersByTime(150));
    expect(barIn(1)).toBeInTheDocument();
    expect(barIn(2)).not.toBeInTheDocument();
    chord(); // focused pane 2 forces ON; pane 1 untouched
    expect(barIn(2)).toBeInTheDocument();
    expect(barIn(1)).toBeInTheDocument();
    chord(); // focused pane 2 forces OFF; pane 1 still lit
    expect(barIn(2)).not.toBeInTheDocument();
    expect(barIn(1)).toBeInTheDocument();
  });

  it("the override auto-clears on the next genuine detector event (no further keypresses)", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    chord(); // force ON while genuinely idle
    expect(barIn(1)).toBeInTheDocument();
    act(() => activity.fire(7, false)); // a genuine fall (even a missed-rise one) clears it
    expect(barIn(1)).not.toBeInTheDocument();

    // Force OFF a lit bar; a genuinely started NEW command re-shows without a keypress.
    vi.useFakeTimers();
    act(() => activity.fire(7, true, { name: "sleep" }));
    act(() => vi.advanceTimersByTime(150));
    expect(barIn(1)).toBeInTheDocument();
    chord(); // rendered-active → force OFF
    expect(barIn(1)).not.toBeInTheDocument();
    act(() => activity.fire(7, false)); // the stuck job "ends" — detector event clears the override
    act(() => activity.fire(7, true, { name: "sleep" })); // a NEW command rises
    act(() => vi.advanceTimersByTime(150));
    expect(barIn(1)).toBeInTheDocument(); // no stale force-off
  });

  it("moves the AI counter numerator in the same interaction (the shared trmx-190 invariant)", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    vi.useFakeTimers();
    act(() => activity.fire(7, true, { name: "claude", args: ["task.md"], stdinTty: true }));
    act(() => vi.advanceTimersByTime(150));
    const segment = () =>
      screen.getByTestId("ai-counter").querySelector('[data-bucket="claude"]')?.textContent;
    expect(segment()).toBe("claude: 1/1");
    chord(); // force the lit bar off → the numerator follows activityVisible
    expect(segment()).toBe("claude: 0/1");
    chord(); // force back on → it returns
    expect(segment()).toBe("claude: 1/1");
  });

  it("the missing-bar case: a dark interactive command force-shows, and the genuine end clears it", async () => {
    // The by-design gap the issue reports as "missing bar": an interactive-classified epoch
    // (bare claude — no argv) with no counted output stays DARK while rawBusy runs (trmx-159's
    // idle-at-prompt trade; the light also drops HOLD_MS after output stops). ⌘⇧A is the rescue.
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    vi.useFakeTimers();
    act(() => activity.fire(7, true, { name: "claude", stdinTty: true })); // interactive, no submit
    act(() => vi.advanceTimersByTime(1000)); // far past the 150ms show delay — still dark
    expect(barIn(1)).not.toBeInTheDocument();
    chord(); // force-show the missing bar
    expect(barIn(1)).toBeInTheDocument();
    act(() => activity.fire(7, false)); // the command genuinely ends → the override auto-clears
    act(() => vi.advanceTimersByTime(1000)); // past any min-visible linger
    expect(barIn(1)).not.toBeInTheDocument();
  });

  it("REGRESSION PIN (reopen-flash): a tab closed mid-flash leaves no bar in a fresh tab", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    fireEvent.click(screen.getByTestId("tab-new")); // a second tab so closing tab 1 keeps the window
    await resolveAttach(calls[1], { sessionId: 8, title: "zsh" });
    clickTab(1);
    const marker = recorder.mounts[0].onPromptMarker!;
    act(() => marker({ kind: "D", busy: false, busyChanged: false, exitCode: 1 })); // flashing
    expect(barIn(1)).toBeInTheDocument();
    // Close the flashing tab, open a fresh one — ids are never reused; dispose must clear the flash.
    fireEvent.click(screen.getByTestId("tab-close-1"));
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[calls.length - 1], { sessionId: 9, title: "zsh" });
    // The fresh tab's pane (id 3 — monotonic allocation) boots with no bar and no stale flash.
    expect(barIn(3)).not.toBeInTheDocument();
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

  it("a rename PINS the tab label + window title but is NOT mirrored to the core; the pane keeps its own title (trmx-166)", async () => {
    const { calls, titleHint, mirrorTitle, setWindowTitle } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "zsh" });
    // The attach mirrors the PANE's effective title into the core session.
    expect(mirrorTitle).toHaveBeenCalledWith(11, "zsh");
    const countAfterAttach = mirrorTitle.mock.calls.length;

    // Rename via the real path (double-click the label, type, Enter) — a TAB-scoped PIN (trmx-166).
    fireEvent.doubleClick(screen.getByTitle("zsh"));
    fireEvent.change(screen.getByTestId("tab-rename-input"), {
      target: { value: "My Tab" },
    });
    fireEvent.keyDown(screen.getByTestId("tab-rename-input"), { key: "Enter" });

    // The tab LABEL and the native WINDOW TITLE show the pin…
    expect(screen.getByTestId("tab-1")).toHaveTextContent("My Tab");
    expect(setWindowTitle).toHaveBeenLastCalledWith("My Tab");
    // …but the pin is a tab-level label — it is NOT mirrored into the core session (which tracks the
    // PANE's own title). No new mirror fired, and never with the manual name.
    expect(mirrorTitle).not.toHaveBeenCalledWith(11, "My Tab");
    expect(mirrorTitle.mock.calls.length).toBe(countAfterAttach);

    // A process hint now updates the PANE's own title → it mirrors to the core session (the pane's
    // real title), while the tab LABEL stays pinned (trmx-166 contract).
    await act(async () => {
      titleHint.fire(11, "vim");
    });
    expect(mirrorTitle).toHaveBeenCalledWith(11, "vim");
    expect(screen.getByTestId("tab-1")).toHaveTextContent("My Tab");
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
    // them onto the strip container. trmx-163: --tab-rail-width is retired (rail width = CSS-owned
    // --tab-bar-thickness). trmx-169: --tab-max-height / --tab-min-height are retired too (tab height
    // = CSS-owned calc(--tab-length + --tab-close-header)), so the vars carried end-to-end are these
    // THREE; the retired height/rail-width vars are never written (asserted).
    expect(stripVar("--tab-close-min")).toBe("24px");
    expect(stripVar("--tab-hint-header")).toBe("20px");
    expect(stripVar("--tab-close-header")).toBe("24px");
    expect(stripVar("--tab-max-height")).toBe(""); // trmx-169: retired, never written
    expect(stripVar("--tab-min-height")).toBe(""); // trmx-169: retired, never written
    expect(stripVar("--tab-rail-width")).toBe(""); // trmx-163: retired, never written
  });

  it("a top/bottom bar forces horizontal labels even when the setting is vertical", () => {
    makeSettingsStore().set("tabs.sideLabelOrientation", "vertical"); // bar stays on the bottom
    renderApp();
    expect(strip().className).toBe("tab-strip");
    // No geometry vars outside vertical-label mode — the horizontal strip is CSS-owned.
    expect(stripVar("--tab-max-height")).toBe("");
    expect(stripVar("--tab-min-height")).toBe("");
    expect(stripVar("--tab-close-min")).toBe("");
    expect(stripVar("--tab-hint-header")).toBe("");
    expect(stripVar("--tab-rail-width")).toBe(""); // trmx-163: retired everywhere
  });

  it("a side bar with the DEFAULT setting keeps the trmx-81 rail (no vars, no label class)", () => {
    makeSettingsStore().set("tabs.barPosition", "right");
    renderApp();
    expect(strip().className).toBe("tab-strip tab-strip--vertical");
    // The horizontal-label rail's 180px width is a CSS-owned constant, not a token. trmx-163: the
    // surviving geometry tokens are the mode signal now (--tab-rail-width is retired everywhere).
    expect(stripVar("--tab-hint-header")).toBe("");
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
    expect(stripVar("--tab-hint-header")).toBe("20px"); // trmx-163: surviving token is the mode signal

    await act(async () => {
      settingsChanged.fire({
        key: "tabs.sideLabelOrientation",
        value: "horizontal",
        source: "config-file",
      });
    });
    expect(strip().className).toBe("tab-strip tab-strip--vertical");
    expect(stripVar("--tab-hint-header")).toBe(""); // back to the CSS-owned 180px rail

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
    expect(stripVar("--tab-hint-header")).toBe("");
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
    expect(stripVar("--tab-hint-header")).toBe(""); // status quo (CSS-owned) — the setting stays latent

    // Back to a side edge: the latent vertical setting re-engages without another broadcast.
    await act(async () => {
      settingsChanged.fire({ key: "tabs.barPosition", value: "right", source: "settings-window" });
    });
    expect(strip().className).toBe("tab-strip tab-strip--vertical tab-strip--labels-vertical");
    expect(stripVar("--tab-hint-header")).toBe("20px");
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

  it("rename PINS the tab title across pane focus changes (multi-pane) (trmx-166)", async () => {
    const { calls, mirrorTitle, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 11, title: "one" });
    cmdD(); // split → pane 2 focused
    await resolveAttach(calls[1], { sessionId: 22, title: "two" });

    await act(async () => tabsAction.fire("rename"));
    const input = screen.getByTestId("tab-rename-input") as HTMLInputElement;
    expect(input.value).toBe("two"); // seeded from the tab title (currently the focused pane's)
    fireEvent.change(input, { target: { value: "deploy" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByTestId("tab-1")).toHaveTextContent("deploy");
    // trmx-166: the rename is a TAB-scoped pin, not a pane manual — it is NOT mirrored to any
    // pane's core session.
    expect(mirrorTitle).not.toHaveBeenCalledWith(22, "deploy");
    // Focus a DIFFERENT pane → the tab title STAYS pinned (the trmx-166 bug fix; it used to revert
    // to the newly focused pane's title).
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("pane-host-1"));
    });
    expect(screen.getByTestId("tab-1")).toHaveTextContent("deploy");
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

// trmx-100 (FR-3.4): ⌘-drag to re-dock a pane. Capture-phase pickup past a slop threshold; a five-zone
// drop target restructures the tree; sessions survive (no remount); a sub-slop ⌘-click is left alone.
describe("App drag re-dock panes (trmx-100)", () => {
  const cmdD = () => fireEvent.keyDown(document.body, { key: "d", metaKey: true });
  const paneLeft = (id: number) => Number.parseInt(screen.getByTestId(`pane-host-${id}`).style.left, 10);
  async function splitOnce(ctx: ReturnType<typeof renderApp>) {
    await resolveAttach(ctx.calls[0], { sessionId: 1, title: "one" });
    cmdD(); // panes 1 | 2 — pane 1 left=0, pane 2 left≈401
    return { one: screen.getByTestId("pane-host-1"), two: screen.getByTestId("pane-host-2") };
  }

  it("⌘-drags pane 1 onto pane 2's right edge → flips to [2|1], no remount, moved pane focused", async () => {
    const ctx = renderApp();
    const { one } = await splitOnce(ctx);
    expect(paneLeft(1)).toBe(0); // pane 1 starts on the left
    fireEvent.pointerDown(one, { pointerId: 1, clientX: 100, clientY: 300, button: 0, metaKey: true });
    fireEvent.pointerMove(one, { pointerId: 1, clientX: 760, clientY: 300 }); // past slop, over pane 2 right
    await act(async () => ctx.frame.flush());
    await act(async () => {
      fireEvent.pointerUp(one, { pointerId: 1, clientX: 760, clientY: 300 });
    });
    expect(paneLeft(1)).toBeGreaterThan(200); // pane 1 is now on the RIGHT ([2|1])
    expect(paneLeft(2)).toBe(0); // pane 2 moved to the left
    expect(recorder.unmounts).toBe(0); // sessions survived — no terminal remounted
  });

  it("raises the shield + clears the xterm selection on pickup; removes the shield on drop", async () => {
    const ctx = renderApp();
    const { one } = await splitOnce(ctx);
    const clearSel = recorder.mounts[0].handle.terminal.clearSelection as ReturnType<typeof vi.fn>;
    expect(screen.queryByTestId("pane-redock-overlay")).not.toBeInTheDocument();
    fireEvent.pointerDown(one, { pointerId: 1, clientX: 100, clientY: 300, button: 0, metaKey: true });
    fireEvent.pointerMove(one, { pointerId: 1, clientX: 600, clientY: 300 }); // past slop
    expect(screen.getByTestId("pane-redock-overlay")).toBeInTheDocument();
    expect(clearSel).toHaveBeenCalled();
    await act(async () => {
      fireEvent.pointerUp(one, { pointerId: 1, clientX: 600, clientY: 300 });
    });
    expect(screen.queryByTestId("pane-redock-overlay")).not.toBeInTheDocument();
  });

  it("a sub-slop ⌘-click does NOT pick up (no shield, no re-dock)", async () => {
    const ctx = renderApp();
    const { one } = await splitOnce(ctx);
    fireEvent.pointerDown(one, { pointerId: 1, clientX: 100, clientY: 300, button: 0, metaKey: true });
    fireEvent.pointerMove(one, { pointerId: 1, clientX: 102, clientY: 301 }); // within slop (< 4px)
    expect(screen.queryByTestId("pane-redock-overlay")).not.toBeInTheDocument();
    fireEvent.pointerUp(one, { pointerId: 1, clientX: 102, clientY: 301 });
    expect(paneLeft(1)).toBe(0); // unchanged — a plain ⌘-click, no re-dock
  });

  it("pointerup commits the final zone from the release coords even if the frame never fired", async () => {
    const ctx = renderApp();
    const { one } = await splitOnce(ctx);
    fireEvent.pointerDown(one, { pointerId: 1, clientX: 100, clientY: 300, button: 0, metaKey: true });
    fireEvent.pointerMove(one, { pointerId: 1, clientX: 760, clientY: 300 }); // queues a frame
    await act(async () => {
      fireEvent.pointerUp(one, { pointerId: 1, clientX: 760, clientY: 300 }); // release before flush
    });
    expect(paneLeft(2)).toBe(0); // the drop WAS committed on release ([2|1])
    expect(ctx.frame.hasPending()).toBe(false);
  });

  it("Escape cancels an in-flight drag (tree unchanged)", async () => {
    const ctx = renderApp();
    const { one } = await splitOnce(ctx);
    fireEvent.pointerDown(one, { pointerId: 1, clientX: 100, clientY: 300, button: 0, metaKey: true });
    fireEvent.pointerMove(one, { pointerId: 1, clientX: 760, clientY: 300 });
    expect(screen.getByTestId("pane-redock-overlay")).toBeInTheDocument();
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(screen.queryByTestId("pane-redock-overlay")).not.toBeInTheDocument();
    expect(paneLeft(1)).toBe(0); // unchanged
  });

  it("pointercancel aborts the drag (no re-dock)", async () => {
    const ctx = renderApp();
    const { one } = await splitOnce(ctx);
    fireEvent.pointerDown(one, { pointerId: 1, clientX: 100, clientY: 300, button: 0, metaKey: true });
    fireEvent.pointerMove(one, { pointerId: 1, clientX: 760, clientY: 300 });
    await act(async () => fireEvent.pointerCancel(one, { pointerId: 1, clientX: 760, clientY: 300 }));
    expect(screen.queryByTestId("pane-redock-overlay")).not.toBeInTheDocument();
    expect(paneLeft(1)).toBe(0); // unchanged
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

// trmx-87 (FR-3.6) + trmx-175: the Kitty multi-pane look. Every divider's base line is `--inactive`; where
// a divider borders the FOCUSED pane, an active-colored `pane-divider__active` overlay covers ONLY that
// segment (a full-height divider next to a bottom pane is colored only over the bottom half). A focus flip
// moves the overlays WITHOUT remounting a terminal; a single-pane tab has no divider (baseline).
// Divider testids: pane-divider-{root,first,second}; overlay testids: pane-divider-active-{root,first,second}.
describe("App multi-pane chrome (trmx-87 / trmx-175)", () => {
  const cls = (testid: string) => screen.getByTestId(testid).className;
  const activeOverlay = (key: string) => screen.queryByTestId(`pane-divider-active-${key}`);

  async function grid2x2(ctx: ReturnType<typeof renderApp>) {
    await resolveAttach(ctx.calls[0], { sessionId: 1, title: "one" });
    fireEvent.keyDown(document.body, { key: "d", metaKey: true }); // ⌘D → pane 2 (focus 2)
    fireEvent.mouseDown(screen.getByTestId("pane-host-1")); // focus 1
    fireEvent.keyDown(document.body, { key: "d", metaKey: true, shiftKey: true }); // ⇧⌘D → pane 3
    fireEvent.mouseDown(screen.getByTestId("pane-host-2")); // focus 2
    fireEvent.keyDown(document.body, { key: "d", metaKey: true, shiftKey: true }); // ⇧⌘D → pane 4 (focus 4)
  }

  it("colors ONLY the segment of each divider that borders the focused pane; the rest inactive", async () => {
    const ctx = renderApp();
    await grid2x2(ctx); // focus = pane 4 (bottom-right): active = root + right-column ("second")
    // base lines are ALWAYS inactive — the active color is an overlay, never the whole-divider class
    expect(cls("pane-divider-root")).toContain("pane-divider--inactive");
    expect(cls("pane-divider-root")).not.toContain("pane-divider--active");
    // overlays exist on the dividers bordering pane 4, and NOT on the left-column divider
    expect(activeOverlay("root")).toBeInTheDocument();
    expect(activeOverlay("second")).toBeInTheDocument();
    expect(activeOverlay("first")).not.toBeInTheDocument(); // left column doesn't bound 4
    // trmx-175: the full-height root divider is colored ONLY over pane 4's (bottom) half — not the whole line
    const dividerH = parseFloat(screen.getByTestId("pane-divider-root").style.height);
    const overlay = activeOverlay("root")!;
    const top = parseFloat(overlay.style.top);
    const height = parseFloat(overlay.style.height);
    expect(top).toBeGreaterThan(0); // NOT from the top (the bug colored the whole line from y=0)
    expect(height).toBeLessThan(dividerH); // strictly partial
    expect(top + height).toBeCloseTo(dividerH, 5); // bottom-aligned: reaches the divider's end, no gap
  });

  it("a focus flip moves the active chrome WITHOUT remounting a terminal (style-only)", async () => {
    const ctx = renderApp();
    await grid2x2(ctx); // focus 4
    const unmountsBefore = recorder.unmounts;
    fireEvent.mouseDown(screen.getByTestId("pane-host-1")); // focus top-left (1): active = root + "first"
    expect(activeOverlay("first")).toBeInTheDocument();
    expect(activeOverlay("second")).not.toBeInTheDocument();
    expect(recorder.unmounts).toBe(unmountsBefore); // re-chrome is a style flip, not a re-layout
  });

  it("a single-pane tab renders NO divider and its pane is focused (baseline, not dimmed)", async () => {
    const ctx = renderApp();
    await resolveAttach(ctx.calls[0], { sessionId: 1, title: "one" });
    expect(screen.queryByTestId("pane-divider-root")).not.toBeInTheDocument();
    // The dim is CSS `.pane-host:not(.pane-host--focused)`; the only pane is focused, so it is never dimmed.
    expect(screen.getByTestId("pane-host-1").className).toContain("pane-host--focused");
  });
});

// trmx-89 (FR-6): the MAIN window owns the theme hot-reload machine (it hosts the live terminals),
// so App installs it once with a settings store and tears it down on unmount. The installer is an
// injected seam so this stays backend-free — its own state machine is covered by themeHotReload.test.ts.
describe("App theme hot-reload wiring (trmx-89)", () => {
  it("installs the hot-reload once (with a settings store) and tears it down on unmount", () => {
    const { view, installHotReload, hotReloadTeardown } = renderApp();
    expect(installHotReload).toHaveBeenCalledTimes(1);
    expect(installHotReload).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.anything() }),
    );
    view.unmount();
    expect(hotReloadTeardown).toHaveBeenCalledTimes(1);
  });
});

// trmx-90 (sub-tasks E + F): per-pane badges. App threads a per-pane onBadge sink into each
// TerminalView (a `printf` in a background pane badges THAT pane, never the focused one) and renders
// the pane's badge as a top-right overlay watermark, colored by the active theme.
describe("App per-pane badges (trmx-90)", () => {
  it("routes a pane's onBadge sink to ONLY that pane's overlay (background isolation)", async () => {
    const { calls, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    await act(async () => tabsAction.fire("split-right"));
    await resolveAttach(calls[1], { sessionId: 2, title: "two" });
    expect(recorder.mounts).toHaveLength(2);

    const unmountsBefore = recorder.unmounts;
    // Pane 1 is now the BACKGROUND pane (the split focused pane 2). Its OSC 1337 sink fires — pane 1
    // gets the badge; pane 2 does not. This is the load-bearing per-pane scoping.
    await act(async () => recorder.mounts[0].onBadge?.("prod"));
    expect(within(screen.getByTestId("pane-host-1")).getByTestId("pane-badge")).toHaveTextContent(
      "prod",
    );
    expect(
      within(screen.getByTestId("pane-host-2")).queryByTestId("pane-badge"),
    ).not.toBeInTheDocument();
    // The badge dispatch re-rendered App WITHOUT remounting any terminal — onBadge is a cached, stable
    // per-pane callback (an unstable identity would remount via TerminalView's effect deps).
    expect(recorder.unmounts).toBe(unmountsBefore);

    // Pane 2's sink is independent; a null (cleared/empty) badge removes ONLY pane 1's overlay.
    await act(async () => recorder.mounts[1].onBadge?.("staging"));
    expect(within(screen.getByTestId("pane-host-2")).getByTestId("pane-badge")).toHaveTextContent(
      "staging",
    );
    await act(async () => recorder.mounts[0].onBadge?.(null));
    expect(
      within(screen.getByTestId("pane-host-1")).queryByTestId("pane-badge"),
    ).not.toBeInTheDocument();
    expect(within(screen.getByTestId("pane-host-2")).getByTestId("pane-badge")).toHaveTextContent(
      "staging",
    );
  });

  it("colors the badge overlay from the active theme's terminal.badge tint", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    await act(async () => recorder.mounts[0].onBadge?.("db"));
    // The default theme is White; its badge tint is a translucent dark (rgba). Assert the overlay
    // carries a color (sourced from resolveTheme(activeThemeId).terminal.badge), not the empty default.
    const badge = within(screen.getByTestId("pane-host-1")).getByTestId("pane-badge");
    expect(badge.style.color).not.toBe("");
    expect(badge).toHaveTextContent("db");
    // trmx-149 (step-8 review-1): the glyph-edge stroke is tinted from the ACTIVE theme's
    // BACKGROUND (color.bg.primary), which App threads as outlineColor. The boot theme in this
    // harness is Night; pin ITS background token so threading the wrong token (e.g. the badge
    // color itself, or a hardcoded value) fails here.
    expect(badge.style.webkitTextStroke.toLowerCase()).toContain(
      night.color.bg.primary.toLowerCase(),
    );
    // jsdom has no canvas 2d context → the default measurer is null → the fit falls back to 28px
    // (no crash with real pane-rect geometry threaded).
    expect(badge.style.fontSize).toBe("28px");
  });

  // review-1 (step-8): pin that App threads the PANE RECT geometry into the fit path — not merely
  // that the overlay renders. With a stubbed 2d context (deterministic measureText), the jsdom
  // pre-ResizeObserver layout (DEFAULT_BOUNDS 800×600 → fit box 400×120) must produce the exact
  // width-bound fit for a long label; wrong/zero geometry threading would land on the 28px fallback
  // (or a different size) and fail.
  it("threads the pane rect into the badge fit: a long label width-fits the 800×600 default bounds (trmx-149)", async () => {
    const proto = HTMLCanvasElement.prototype;
    const original = proto.getContext;
    // width = chars × 0.6 × fontPx (linear fake); height comes from the overlay's line math.
    // "production-cluster" = 18 chars → 10.8×f ≤ 400 → f ≤ 37.03 → the integer search lands on 37.
    (proto as { getContext: unknown }).getContext = function (kind: string) {
      if (kind !== "2d") return null;
      let font = "";
      return {
        set font(value: string) {
          font = value;
        },
        get font() {
          return font;
        },
        measureText: (text: string) => ({
          // The font string is e.g. `bold 52px Helvetica, …` — extract the px size.
          width: text.length * 0.6 * (Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]) || 0),
        }),
      };
    };
    try {
      const { calls } = renderApp();
      await resolveAttach(calls[0], { sessionId: 1, title: "one" });
      await act(async () => recorder.mounts[0].onBadge?.("production-cluster"));
      const badge = within(screen.getByTestId("pane-host-1")).getByTestId("pane-badge");
      expect(badge.style.fontSize).toBe("37px");
    } finally {
      proto.getContext = original;
    }
  });

  // review-1: the badge color must repaint on a SAME-ID trmx-89 hot reload — the designer edits their
  // ACTIVE user theme's terminal.badge; trmx-89 re-registers the tokens and re-emits appearance.theme
  // with the SAME id. Keying on the id alone would no-op setState and leave the overlay on the stale
  // color; tracking the resolved color repaints it.
  it("repaints the badge color on a same-id user-theme hot reload (review-1)", async () => {
    const ANSI = {
      black: "#000", red: "#f00", green: "#0f0", yellow: "#ff0", blue: "#00f", magenta: "#f0f",
      cyan: "#0ff", white: "#fff", brightBlack: "#888", brightRed: "#f88", brightGreen: "#8f8",
      brightYellow: "#ff8", brightBlue: "#88f", brightMagenta: "#f8f", brightCyan: "#8ff", brightWhite: "#fff",
    };
    const specWithBadge = (badge: string): ThemeSpec => ({
      isDark: true,
      color: { bg: { primary: "#111111" }, text: { primary: "#eeeeee" }, accent: {}, semantic: {} },
      terminal: { ansi: { ...ANSI }, scrollbar: {}, pane: {}, badge },
    });
    const register = (badge: string) =>
      registerUserThemes([
        { id: "user:designer", source: "user", valid: true, spec: specWithBadge(badge), warnings: [] },
      ]);

    const { calls, settingsChanged } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    await act(async () => recorder.mounts[0].onBadge?.("db"));
    const badge = () => within(screen.getByTestId("pane-host-1")).getByTestId("pane-badge");

    // Switch to the user theme (badge = colorA).
    register("rgba(1, 2, 3, 0.1)");
    await act(async () =>
      settingsChanged.fire({ key: "appearance.theme", value: "user:designer", source: "manual" }),
    );
    const colorA = badge().style.color;
    expect(colorA).not.toBe("");

    // Edit the SAME theme file → new badge (colorB); trmx-89 re-registers + re-emits the SAME id.
    register("rgba(9, 8, 7, 0.2)");
    await act(async () =>
      settingsChanged.fire({ key: "appearance.theme", value: "user:designer", source: "themes-reload" }),
    );
    // The overlay repaints (was stale before the fix: same id no-op'd setState).
    expect(badge().style.color).not.toBe(colorA);

    clearUserThemes();
  });
});

// trmx-173: the main window applies the theme's --tx-* vars onto documentElement on EVERY
// appearance.theme event, so the tab bar / chrome (themed only via --tx-*) recolor with the terminal
// — before the fix they were stuck on the static :root fallback (the tab bar stayed dark). Keyed on
// the event (not the theme id) so a trmx-89 same-id file edit re-applies the changed tokens.
describe("App main-window theme vars (trmx-173)", () => {
  const sunken = () => document.documentElement.style.getPropertyValue("--tx-bg-sunken");

  beforeEach(() => {
    document.documentElement.style.cssText = "";
    document.body.style.cssText = "";
  });
  afterEach(() => clearUserThemes());

  it("writes the mapped --tx-* vars on a theme switch (the tab-bar var flips)", async () => {
    const { settingsChanged } = renderApp();
    expect(sunken()).toBe(""); // the main window had applied no vars yet (documentElement was clear)
    await act(async () =>
      settingsChanged.fire({ key: "appearance.theme", value: "catppuccin-latte", source: "settings-window" }),
    );
    expect(sunken()).toBe("#e6e9ef"); // Latte's sunken bg (mantle) → the tab bar recolors light
    await act(async () =>
      settingsChanged.fire({ key: "appearance.theme", value: "night", source: "settings-window" }),
    );
    expect(sunken()).not.toBe(""); // Night's sunken bg (dark), non-empty
    expect(sunken()).not.toBe("#e6e9ef"); // …and different from Latte's
  });

  // trmx-202: a REMOVED built-in over the bus normalizes to the derived default (jsdom → night)
  // so the chrome re-themes instead of ignoring the event.
  it("re-themes the chrome to the derived default on a removed built-in id", async () => {
    const { settingsChanged } = renderApp();
    await act(async () =>
      settingsChanged.fire({ key: "appearance.theme", value: "catppuccin-latte", source: "settings-window" }),
    );
    expect(sunken()).toBe("#e6e9ef"); // parked on Latte first
    await act(async () =>
      settingsChanged.fire({ key: "appearance.theme", value: "white", source: "config-file" }),
    );
    expect(sunken()).toBe("#0a0a0a"); // normalized to Night's sunken bg, not ignored
  });

  it("re-applies the --tx-* vars on a same-id user-theme hot reload (changed bg tokens)", async () => {
    const ANSI = {
      black: "#000", red: "#f00", green: "#0f0", yellow: "#ff0", blue: "#00f", magenta: "#f0f",
      cyan: "#0ff", white: "#fff", brightBlack: "#888", brightRed: "#f88", brightGreen: "#8f8",
      brightYellow: "#ff8", brightBlue: "#88f", brightMagenta: "#f8f", brightCyan: "#8ff", brightWhite: "#fff",
    };
    const specWithBg = (bg: string): ThemeSpec => ({
      isDark: true,
      color: { bg: { primary: bg }, text: { primary: "#eeeeee" }, accent: {}, semantic: {} },
      terminal: { ansi: { ...ANSI }, scrollbar: {}, pane: {}, badge: "rgba(0, 0, 0, 0.1)" },
    });
    const register = (bg: string) =>
      registerUserThemes([
        { id: "user:designer", source: "user", valid: true, spec: specWithBg(bg), warnings: [] },
      ]);

    const { settingsChanged } = renderApp();

    register("#111111");
    await act(async () =>
      settingsChanged.fire({ key: "appearance.theme", value: "user:designer", source: "manual" }),
    );
    const sunkenA = sunken();
    expect(sunkenA).not.toBe("");

    // Edit the SAME theme file → different bg tokens; trmx-89 re-registers + re-emits the SAME id.
    register("#772211");
    await act(async () =>
      settingsChanged.fire({ key: "appearance.theme", value: "user:designer", source: "themes-reload" }),
    );
    expect(sunken()).not.toBe(sunkenA); // the --tx-* vars re-applied despite the unchanged id
  });
});

// trmx-90 (sub-task G-frontend): the ⇧⌘B inline badge EDITOR — a centered input over the focused
// pane (the menu accelerator emits the "set-badge" tabs:action; App opens the editor). Enter commits
// (empty → clear), Esc AND blur cancel; edit-in-place seeds the input with the pane's current badge.
describe("App badge editor (trmx-90)", () => {
  it("'set-badge' opens the editor on the FOCUSED pane; type + Enter sets that pane's badge", async () => {
    const { calls, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });

    await act(async () => tabsAction.fire("set-badge"));
    const input = screen.getByTestId("pane-badge-input") as HTMLInputElement;
    expect(input.value).toBe(""); // no badge yet
    expect(document.activeElement).toBe(input); // keyboard-operable the instant it opens

    fireEvent.change(input, { target: { value: "prod" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByTestId("pane-badge-input")).not.toBeInTheDocument(); // editor closed
    expect(within(screen.getByTestId("pane-host-1")).getByTestId("pane-badge")).toHaveTextContent(
      "prod",
    );
  });

  it("Esc cancels the edit with no change", async () => {
    const { calls, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });

    await act(async () => tabsAction.fire("set-badge"));
    const input = screen.getByTestId("pane-badge-input");
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("pane-badge-input")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("pane-host-1")).queryByTestId("pane-badge"),
    ).not.toBeInTheDocument();
  });

  it("blur cancels the edit (no dispatch)", async () => {
    const { calls, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });

    await act(async () => tabsAction.fire("set-badge"));
    const input = screen.getByTestId("pane-badge-input");
    fireEvent.change(input, { target: { value: "temp" } });
    fireEvent.blur(input);

    expect(screen.queryByTestId("pane-badge-input")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("pane-host-1")).queryByTestId("pane-badge"),
    ).not.toBeInTheDocument();
  });

  it("edit-in-place: seeds the input with the current badge; empty + Enter clears it", async () => {
    const { calls, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });

    // Seed a badge (via the pane's OSC sink), then re-open the editor: it edits in place.
    await act(async () => recorder.mounts[0].onBadge?.("prod"));
    expect(within(screen.getByTestId("pane-host-1")).getByTestId("pane-badge")).toHaveTextContent(
      "prod",
    );

    await act(async () => tabsAction.fire("set-badge"));
    const input = screen.getByTestId("pane-badge-input") as HTMLInputElement;
    expect(input.value).toBe("prod"); // seeded with the current badge

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      within(screen.getByTestId("pane-host-1")).queryByTestId("pane-badge"),
    ).not.toBeInTheDocument(); // empty commit cleared it
  });

  it("⌘1..⌘9 are inert while the badge input has focus (editable non-terminal target)", async () => {
    const { calls, tabsAction } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(calls[1], { sessionId: 2, title: "two" });
    clickTab(1);
    expect(screen.getByTestId("tab-1").className).toContain(activeClass);

    await act(async () => tabsAction.fire("set-badge"));
    // The chord lands ON the input — the keymap's editable-non-terminal veto keeps it a keystroke.
    fireEvent.keyDown(screen.getByTestId("pane-badge-input"), { key: "2", metaKey: true });
    expect(screen.getByTestId("tab-1").className).toContain(activeClass);
    expect(screen.getByTestId("pane-badge-input")).toBeInTheDocument(); // still editing
  });
});

// trmx-91 (sub-tasks E + F): the per-pane ACTIVITY LINE. App subscribes to session:activity, routes
// each busy<->idle transition by sessionId into the OWNING pane, drives the pure debounce (150ms show
// delay / 300ms min-visible hold) via a single per-pane timer, and renders the top-edge line — gated
// on the terminal.activityIndicator setting. Fake timers drive the debounce deterministically (the
// debounce reads Date.now() + setTimeout, both faked); they are enabled only AFTER the async attach so
// every async `act` (render/attach) stays on real timers and the fake portion uses only sync `act`.
describe("App activity indicator (trmx-91)", () => {
  beforeEach(() => {
    __resetSettingsForTest();
  });
  afterEach(() => {
    vi.useRealTimers(); // a no-op when a test never enabled fake timers
    __resetSettingsForTest();
  });

  const activityLineIn = (paneId: number) =>
    within(screen.getByTestId(`pane-host-${paneId}`)).queryByTestId("pane-activity");

  it("shows the owning pane's line after the 150ms show delay and holds it 300ms after idle", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    vi.useFakeTimers();

    // Busy with a PLAIN foreground program (an unlisted name) — plain lights whenever visible, so the
    // 150ms show / 300ms min-visible debounce is exactly the trmx-91 behavior. The line must NOT flash
    // before the 150ms show floor is crossed.
    act(() => activity.fire(7, true, { name: "sleep" }));
    expect(activityLineIn(1)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(149));
    expect(activityLineIn(1)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1)); // cross 150ms → the line appears
    expect(activityLineIn(1)).toBeInTheDocument();

    // Idle — the line HOLDS through the 300ms min-visible window, then clears (no strobe).
    act(() => activity.fire(7, false));
    expect(activityLineIn(1)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(299));
    expect(activityLineIn(1)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1)); // cross the 300ms min-visible floor → clears
    expect(activityLineIn(1)).not.toBeInTheDocument();
  });

  it("OSC 133 owns rawBusy but a C-rise stays DARK until classified as executing work (trmx-159, finding #3)", async () => {
    const { calls, activity, input, output } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    vi.useFakeTimers();
    const marker = recorder.mounts[0].onPromptMarker!;
    // A command starts (OSC 133;C) with NO classification metadata → the epoch is born `unknown` and
    // stays DARK, even past the old 150ms show delay (an idle Claude no longer lights). rawBusy is
    // owned by OSC 133 throughout.
    act(() => marker({ kind: "C", busy: true, busyChanged: true }));
    act(() => vi.advanceTimersByTime(200));
    expect(activityLineIn(1)).not.toBeInTheDocument();
    // The poller's busy=false is IGNORED for this latched pane (rawBusy stays with OSC 133 — no
    // change), but its classification metadata (interactive) IS consumed.
    act(() => activity.fire(7, false, { name: "claude" }));
    act(() => vi.advanceTimersByTime(50));
    expect(activityLineIn(1)).not.toBeInTheDocument(); // classified interactive, but no submit yet ⇒ dark
    // A submit (Enter) opens the window; counted output in the window lights the line — the pane is
    // now actually executing user work.
    act(() => input.fire(7, "\r"));
    act(() => vi.advanceTimersByTime(400)); // clear the echo window
    act(() => output.fire(7, 4096));
    expect(activityLineIn(1)).toBeInTheDocument();
    // The command finishes via OSC 133 (D, exit 0) → the epoch closes → the line clears.
    act(() => marker({ kind: "D", busy: false, busyChanged: true, exitCode: 0 }));
    act(() => vi.advanceTimersByTime(700));
    expect(activityLineIn(1)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a failed command (D;1) flashes the line after it finishes, then clears (trmx-99)", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    vi.useFakeTimers();
    const marker = recorder.mounts[0].onPromptMarker!;
    act(() => marker({ kind: "C", busy: true, busyChanged: true }));
    act(() => vi.advanceTimersByTime(150));
    // Finish with a non-zero exit → busy clears, but the flash keeps the line painting for FLASH_MS.
    act(() => marker({ kind: "D", busy: false, busyChanged: true, exitCode: 1 }));
    act(() => vi.advanceTimersByTime(300)); // past min-visible; the flash (600ms) still shows the line
    expect(activityLineIn(1)).toBeInTheDocument();
    // trmx-160: the flash keeps its trmx-99 look — the --flash variant painted in the error color,
    // NOT the new green progress bar (a flash must never turn green).
    const flashLine = activityLineIn(1)!;
    expect(flashLine.className).toContain("tx-activity-line--flash");
    expect(flashLine.className).not.toContain("tx-activity-line--progress");
    expect(flashLine.style.backgroundColor).not.toBe("");
    act(() => vi.advanceTimersByTime(400)); // past FLASH_MS → the flash clears
    expect(activityLineIn(1)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("never flashes for an instant job (busy then idle within the 150ms show delay)", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    vi.useFakeTimers();

    act(() => activity.fire(7, true));
    act(() => vi.advanceTimersByTime(100)); // still inside the show delay
    act(() => activity.fire(7, false)); // the job finished before the line ever showed
    act(() => vi.advanceTimersByTime(1000)); // drain every timer
    expect(activityLineIn(1)).not.toBeInTheDocument();
  });

  it("gates on the terminal.activityIndicator setting: OFF hides the line, back ON reveals it", async () => {
    const { calls, activity, settingsChanged } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    vi.useFakeTimers();
    act(() => activity.fire(7, true, { name: "sleep" })); // plain ⇒ lights whenever visible
    act(() => vi.advanceTimersByTime(150));
    expect(activityLineIn(1)).toBeInTheDocument();

    // OFF → hidden. Only the RENDER is gated — the pane's debounced state is untouched.
    act(() =>
      settingsChanged.fire({
        key: "terminal.activityIndicator",
        value: false,
        source: "settings-window",
      }),
    );
    expect(activityLineIn(1)).not.toBeInTheDocument();

    // Back ON → the still-busy pane's line reappears with no new activity event.
    act(() =>
      settingsChanged.fire({
        key: "terminal.activityIndicator",
        value: true,
        source: "settings-window",
      }),
    );
    expect(activityLineIn(1)).toBeInTheDocument();

    // A non-boolean value for the key is inert (the untrusted-payload guard).
    act(() =>
      settingsChanged.fire({
        key: "terminal.activityIndicator",
        value: "nope",
        source: "config-file",
      }),
    );
    expect(activityLineIn(1)).toBeInTheDocument();
  });

  it("scopes a BACKGROUND pane's activity to THAT pane's line only (per-pane routing)", async () => {
    const { calls, tabsAction, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "one" });
    await act(async () => tabsAction.fire("split-right")); // focus moves to the new pane 2
    await resolveAttach(calls[1], { sessionId: 2, title: "two" });
    vi.useFakeTimers();

    // Session 1 owns the now-BACKGROUND pane 1. Its busy transition (plain) lights pane 1's line ONLY.
    act(() => activity.fire(1, true, { name: "sleep" }));
    act(() => vi.advanceTimersByTime(150));
    expect(activityLineIn(1)).toBeInTheDocument();
    expect(activityLineIn(2)).not.toBeInTheDocument();
  });

  // trmx-160: the busy line is the iTerm2 progress-bar clone, keyed on the theme MODE App derives from
  // resolveTheme(themeId).isDark and re-derives on every theme switch. A dark theme ⇒ --dark; a light
  // theme ⇒ --light; the bar is no longer inline-colored (its track + green sweep are theme-independent CSS).
  it("renders the progress bar keyed on the theme mode, re-keying live on a theme switch (trmx-160)", async () => {
    const { calls, activity, settingsChanged } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    vi.useFakeTimers();

    // A known DARK theme (night) → the busy progress bar carries --dark and no inline color.
    act(() =>
      settingsChanged.fire({ key: "appearance.theme", value: "night", source: "settings-window" }),
    );
    act(() => activity.fire(7, true, { name: "sleep" }));
    act(() => vi.advanceTimersByTime(150));
    let line = within(screen.getByTestId("pane-host-1")).getByTestId("pane-activity");
    expect(line.className).toContain("tx-activity-line--progress");
    expect(line.className).toContain("tx-activity-line--dark");
    expect(line.style.backgroundColor).toBe("");

    // Switching to a known LIGHT theme (catppuccin-latte) re-keys the still-busy pane's bar to --light.
    act(() =>
      settingsChanged.fire({ key: "appearance.theme", value: "catppuccin-latte", source: "settings-window" }),
    );
    line = within(screen.getByTestId("pane-host-1")).getByTestId("pane-activity");
    expect(line.className).toContain("tx-activity-line--light");
  });

  it("is inert for activity on an unknown session (no line anywhere)", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    vi.useFakeTimers();
    act(() => activity.fire(4040, true)); // no pane owns this session
    act(() => vi.advanceTimersByTime(150));
    expect(activityLineIn(1)).not.toBeInTheDocument();
  });

  // trmx-159: a poller rise born INTERACTIVE (an AI CLI) sits idle DARK, then lights only once it is
  // actually executing user work (a submit opens the window, output lights it), and drops afterward.
  it("keeps an interactive program dark until it executes user work, then lights and drops (trmx-159)", async () => {
    const { calls, activity, input, output } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    vi.useFakeTimers();

    // Claude launches (poller rise born classified interactive) — idle at its prompt ⇒ NO line, even
    // past the show delay (the whole point of trmx-159).
    act(() => activity.fire(7, true, { name: "claude" }));
    act(() => vi.advanceTimersByTime(300));
    expect(activityLineIn(1)).not.toBeInTheDocument();

    // The user submits a prompt and Claude answers (output) ⇒ the line lights.
    act(() => input.fire(7, "\r"));
    act(() => vi.advanceTimersByTime(400)); // clear the echo window
    act(() => output.fire(7, 4096));
    expect(activityLineIn(1)).toBeInTheDocument();

    // ~3s after the last output (no more work, no busy event) ⇒ the line drops (timer-driven).
    act(() => vi.advanceTimersByTime(3100));
    expect(activityLineIn(1)).not.toBeInTheDocument();
  });

  // trmx-159: a silent PLAIN command (e.g. `sleep 30`, which produces no output) lights its whole run,
  // exactly as before — plain lighting is rawBusy-driven, not output-driven.
  it("lights a silent plain command for its whole run (trmx-159)", async () => {
    const { calls, activity } = renderApp();
    await resolveAttach(calls[0], { sessionId: 7, title: "zsh" });
    vi.useFakeTimers();

    act(() => activity.fire(7, true, { name: "sleep", args: ["30"], stdinTty: true }));
    act(() => vi.advanceTimersByTime(150));
    expect(activityLineIn(1)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000)); // still running, still lit — no output needed
    expect(activityLineIn(1)).toBeInTheDocument();
    // The command exits ⇒ idle ⇒ clears after the min-visible hold.
    act(() => activity.fire(7, false));
    act(() => vi.advanceTimersByTime(400));
    expect(activityLineIn(1)).not.toBeInTheDocument();
  });
});

// trmx-151 (test-first): the ⌘N tab hints, threaded end-to-end — App hands the strip its live
// EFFECTIVE keymap (the trmx-94 state: defaults ⊕ user [keys], rebuilt by readKeys on mount and
// on every keys:changed signal) plus a `shortcutHintsOn` state mirroring tabs.showShortcutHints
// exactly like activityIndicatorOn (seeded from the shared snapshot, kept live over
// settings:changed with the untrusted-payload guard).
describe("App tab shortcut hints (trmx-151)", () => {
  beforeEach(() => {
    __resetSettingsForTest();
  });
  afterEach(() => {
    __resetSettingsForTest();
  });

  const hintIn = (tabId: number) =>
    screen.getByTestId(`tab-${tabId}`).querySelector(".tab-strip__hint");

  it("shows the ⌘1 hint on the first tab with the default keymap", async () => {
    const { calls } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "zsh" });
    const hint = hintIn(1);
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe("⌘1");
    expect(screen.getByTestId("tab-1")).toHaveAttribute("aria-keyshortcuts", "Meta+1");
  });

  it("flipping tabs.showShortcutHints removes/restores the hints LIVE (settings:changed)", async () => {
    const { calls, settingsChanged } = renderApp();
    await resolveAttach(calls[0], { sessionId: 1, title: "zsh" });
    expect(hintIn(1)).not.toBeNull();

    // OFF → the prefix disappears without a re-mount (the settings-window toggle path).
    act(() =>
      settingsChanged.fire({
        key: "tabs.showShortcutHints",
        value: false,
        source: "settings-window",
      }),
    );
    expect(hintIn(1)).toBeNull();
    expect(screen.getByTestId("tab-1")).not.toHaveAttribute("aria-keyshortcuts");

    // Back ON → it returns.
    act(() =>
      settingsChanged.fire({
        key: "tabs.showShortcutHints",
        value: true,
        source: "settings-window",
      }),
    );
    expect(hintIn(1)).not.toBeNull();

    // A non-boolean value for the key is inert (the untrusted-payload guard).
    act(() =>
      settingsChanged.fire({
        key: "tabs.showShortcutHints",
        value: "nope",
        source: "config-file",
      }),
    );
    expect(hintIn(1)).not.toBeNull();
  });

  it("a [keys] rebuild rethreads the hint (the keymap-prop threading)", async () => {
    // Drives the SAME rebuild code path a keys:changed signal calls (readKeys → mergeKeymap →
    // setKeymap), via the injected invoke's keys_read: firing the literal keys:changed event is
    // impractical here — onKeysChanged subscribes on the real Tauri bus, which App exposes no
    // seam for — so this pins the keymap-prop threading instead. cmd+1 is unbound ("none" —
    // mergeKeymap deletes the chord) and a replacement bound → slot 1 hints the survivor.
    const invoke = vi.fn((cmd: string) =>
      Promise.resolve(cmd === "keys_read" ? { "cmd+1": "none", "cmd+b": "tab.select-1" } : null),
    );
    const { calls } = renderApp({ invoke });
    await resolveAttach(calls[0], { sessionId: 1, title: "zsh" });
    await act(async () => {}); // flush the readKeys(invoke) microtask → setKeymap lands
    expect(invoke).toHaveBeenCalledWith("keys_read");
    const hint = hintIn(1);
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe("⌘B"); // the rebound chord, not the unbound default
    expect(screen.getByTestId("tab-1")).toHaveAttribute("aria-keyshortcuts", "Meta+B");
  });
});
