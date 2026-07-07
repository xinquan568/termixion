// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-144 (test-first): confirm-before-closing-busy. App gates every USER-initiated pane / tab /
// window close on the closeGuard policy (terminal.confirmClose × the pane's RAW busy state) and
// mounts ConfirmCloseDialog instead of closing; a remote (control-channel) close and an auto close
// (pty:exited) never prompt. The quit half: the backend's `close:requested` round-trip is answered
// with the quitConfirmed seam once the gesture is authorized (idle, confirmed, or an already-gated
// last-tab close), and a "quit" dialog otherwise. Same headless harness as App.test.tsx: TerminalView
// stubbed, every runtime edge injected via App's seam props.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { SessionInfo } from "./ipc/backend";

vi.mock("./terminal/TerminalView", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalView: ({ onReady }: { onReady?: (h: unknown) => void }) => {
      useEffect(() => {
        onReady?.({
          terminal: { focus: vi.fn(), clearSelection: vi.fn() },
          renderer: "dom",
          fit: () => {},
          dispose: () => {},
        });
      }, [onReady]);
      return <div data-testid="terminal-view-stub" />;
    },
  };
});
vi.mock("./ipc/useBackend", () => ({
  useBackend: () => ({ coreVersion: "0.0.2", attachTerminal: vi.fn() }),
}));
vi.mock("./update/UpdateAuthorityHost", () => ({
  UpdateAuthorityHost: () => <div data-testid="update-authority-host" />,
}));

import { App, type AppProps, type ControlRequest } from "./App";
import { makeSettingsStore, __resetSettingsForTest } from "./settings/settingsStore";

interface AttachCall {
  resolve: (info: SessionInfo) => void;
  reject: (err: unknown) => void;
}

// A controllable attach (the App.test.tsx idiom): each call parks its resolvers.
function makeAttach() {
  const calls: AttachCall[] = [];
  const attach = vi.fn(
    () =>
      new Promise<SessionInfo>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  return { attach, calls };
}

// A capturable one-value observation seam; tests fire the captured handler.
function makeObservation<T>() {
  let handler: ((value: T) => void) | undefined;
  const observe = vi.fn((h: (value: T) => void) => {
    handler = h;
    return vi.fn();
  });
  return { observe, fire: (value: T) => handler?.(value) };
}

// The (sessionId, name) title-hint seam — sets the pane's `process` title slot (the dialog's name).
function makeHintObservation() {
  let handler: ((sessionId: number, name: string) => void) | undefined;
  const observe = vi.fn((h: (sessionId: number, name: string) => void) => {
    handler = h;
    return vi.fn();
  });
  return { observe, fire: (sessionId: number, name: string) => handler?.(sessionId, name) };
}

// The (sessionId, busy) session:activity seam — flips the pane's RAW busy state (closeGuard input).
function makeActivityObservation() {
  let handler: ((sessionId: number, busy: boolean) => void) | undefined;
  const observe = vi.fn((h: (sessionId: number, busy: boolean) => void) => {
    handler = h;
    return vi.fn();
  });
  return { observe, fire: (sessionId: number, busy: boolean) => handler?.(sessionId, busy) };
}

// The zero-arg close:requested seam (the backend's native-close round-trip).
function makeVoidObservation() {
  let handler: (() => void) | undefined;
  const observe = vi.fn((h: () => void) => {
    handler = h;
    return vi.fn();
  });
  return { observe, fire: () => handler?.() };
}

function renderApp() {
  const { attach, calls } = makeAttach();
  const closeWindow = vi.fn();
  const quitConfirmed = vi.fn();
  const closeSession = vi.fn(() => Promise.resolve());
  const tabsAction = makeObservation<unknown>();
  const ptyExited = makeObservation<number>();
  const titleHint = makeHintObservation();
  const activity = makeActivityObservation();
  const controlRequest = makeObservation<ControlRequest>();
  const closeRequested = makeVoidObservation();
  const invoke = vi.fn(() => Promise.resolve({}));
  const props: AppProps = {
    attach,
    closeWindow,
    quitConfirmed,
    closeSession,
    observeTabsAction: tabsAction.observe,
    observePtyExited: ptyExited.observe,
    observeTitleHint: titleHint.observe,
    observeActivity: activity.observe,
    observeSettings: makeObservation<unknown>().observe,
    observeControlRequest: controlRequest.observe,
    observeCloseRequested: closeRequested.observe,
    setWindowTitle: vi.fn(),
    mirrorTitle: vi.fn(() => Promise.resolve()),
    installHotReload: vi.fn(() => vi.fn()),
    invoke,
  };
  render(<App {...props} />);
  return {
    attach,
    calls,
    closeWindow,
    quitConfirmed,
    closeSession,
    tabsAction,
    ptyExited,
    titleHint,
    activity,
    controlRequest,
    closeRequested,
    invoke,
  };
}
type Seams = ReturnType<typeof renderApp>;

async function resolveAttach(call: AttachCall, info: SessionInfo) {
  await act(async () => {
    call.resolve(info);
  });
}

const cmdW = () => fireEvent.keyDown(document.body, { key: "w", metaKey: true });
const cmdD = () => fireEvent.keyDown(document.body, { key: "d", metaKey: true });
const cmdT = () => fireEvent.keyDown(document.body, { key: "t", metaKey: true });

const dialog = () => screen.queryByTestId("confirm-close");
const dialogButton = (name: string) =>
  within(screen.getByTestId("confirm-close")).getByRole("button", { name });

// One tab, two panes (1 | 2), pane 2 focused with session 22 RAW-busy — the standard gate setup.
async function splitWithBusyPane2(seams: Seams) {
  await resolveAttach(seams.calls[0], { sessionId: 11, title: "one" });
  cmdD();
  await resolveAttach(seams.calls[1], { sessionId: 22, title: "two" });
  act(() => seams.activity.fire(22, true));
}

const setConfirmClose = (value: "never" | "when-busy" | "always") =>
  makeSettingsStore().set("terminal.confirmClose", value);

beforeEach(() => {
  __resetSettingsForTest(); // terminal.confirmClose reverts to its "when-busy" default
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetSettingsForTest();
});

describe("confirm-before-close: the pane gate (trmx-144)", () => {
  it("when-busy: ⌘W on a BUSY pane prompts instead of closing", async () => {
    const seams = renderApp();
    await splitWithBusyPane2(seams);

    cmdW();

    expect(dialog()).toBeInTheDocument();
    expect(dialog()).toHaveTextContent("Close this pane?");
    // The busy pane's display name (its effective title, no process hint yet) is spelled out.
    expect(dialog()).toHaveTextContent("two is still running.");
    expect(screen.getByTestId("pane-host-2")).toBeInTheDocument(); // NOT closed
    expect(seams.closeSession).not.toHaveBeenCalled();
    expect(seams.closeWindow).not.toHaveBeenCalled();
  });

  it("confirm closes the pane it prompted for", async () => {
    const seams = renderApp();
    await splitWithBusyPane2(seams);
    cmdW();

    fireEvent.click(dialogButton("Close"));

    expect(dialog()).toBeNull();
    expect(screen.queryByTestId("pane-host-2")).not.toBeInTheDocument();
    expect(seams.closeSession).toHaveBeenCalledExactlyOnceWith(22);
  });

  it("cancel keeps the pane and drops the dialog", async () => {
    const seams = renderApp();
    await splitWithBusyPane2(seams);
    cmdW();

    fireEvent.click(dialogButton("Cancel"));

    expect(dialog()).toBeNull();
    expect(screen.getByTestId("pane-host-2")).toBeInTheDocument();
    expect(seams.closeSession).not.toHaveBeenCalled();
  });

  it("when-busy: an IDLE pane closes immediately, no dialog", async () => {
    const seams = renderApp();
    await resolveAttach(seams.calls[0], { sessionId: 11, title: "one" });
    cmdD();
    await resolveAttach(seams.calls[1], { sessionId: 22, title: "two" });

    cmdW();

    expect(dialog()).toBeNull();
    expect(screen.queryByTestId("pane-host-2")).not.toBeInTheDocument();
    expect(seams.closeSession).toHaveBeenCalledExactlyOnceWith(22);
  });

  it("never: even a BUSY pane closes immediately", async () => {
    const seams = renderApp();
    await splitWithBusyPane2(seams);
    setConfirmClose("never");

    cmdW();

    expect(dialog()).toBeNull();
    expect(seams.closeSession).toHaveBeenCalledExactlyOnceWith(22);
  });

  it("always: an IDLE pane prompts (with no still-running line)", async () => {
    const seams = renderApp();
    await resolveAttach(seams.calls[0], { sessionId: 11, title: "one" });
    cmdD();
    await resolveAttach(seams.calls[1], { sessionId: 22, title: "two" });
    setConfirmClose("always");

    cmdW();

    expect(dialog()).toBeInTheDocument();
    expect(dialog()).not.toHaveTextContent("still running");
    expect(seams.closeSession).not.toHaveBeenCalled();
  });

  it("a REMOTE (control-channel) close never prompts, even under always", async () => {
    const seams = renderApp();
    await splitWithBusyPane2(seams);
    setConfirmClose("always");

    act(() => seams.controlRequest.fire({ id: 1, request: { cmd: "pane.close" } }));

    expect(dialog()).toBeNull();
    expect(screen.queryByTestId("pane-host-2")).not.toBeInTheDocument();
    expect(seams.closeSession).toHaveBeenCalledExactlyOnceWith(22);
  });

  it("an AUTO close (pty:exited) never prompts under when-busy + busy", async () => {
    const seams = renderApp();
    await splitWithBusyPane2(seams);

    act(() => seams.ptyExited.fire(22));

    expect(dialog()).toBeNull();
    expect(screen.queryByTestId("pane-host-2")).not.toBeInTheDocument();
    expect(seams.closeSession).not.toHaveBeenCalled(); // already exited — no redundant close_pty
  });
});

describe("confirm-before-close: the open dialog owns the surface (trmx-144)", () => {
  it("a second close gesture while the dialog is up is swallowed (exactly one dialog)", async () => {
    const seams = renderApp();
    await splitWithBusyPane2(seams);
    cmdW();

    cmdW(); // the keymap gate swallows the chord
    await act(async () => seams.tabsAction.fire("close")); // the close gate swallows the menu verb

    expect(screen.getAllByTestId("confirm-close")).toHaveLength(1);
    expect(screen.getByTestId("pane-host-2")).toBeInTheDocument();
    expect(seams.closeSession).not.toHaveBeenCalled();
  });

  it("the keymap is gated while the dialog is up: ⌘T is inert until cancel", async () => {
    const seams = renderApp();
    await splitWithBusyPane2(seams);
    cmdW();

    cmdT();
    expect(screen.queryByTestId("tab-2")).not.toBeInTheDocument(); // no new tab under the dialog
    expect(seams.attach).toHaveBeenCalledTimes(2);

    fireEvent.click(dialogButton("Cancel"));
    cmdT();
    expect(screen.getByTestId("tab-2")).toBeInTheDocument(); // the chord works again
  });

  it("the native menu path is gated while the dialog is up: a tabs:action verb is inert until cancel", async () => {
    // Packaged menu accelerators (⌘T etc.) arrive as tabs:action events, NOT DOM keydowns — the
    // modal gate must cover this channel too, or the dialog can be driven around from the menu.
    const seams = renderApp();
    await splitWithBusyPane2(seams);
    cmdW();

    act(() => seams.tabsAction.fire("new"));
    expect(screen.queryByTestId("tab-2")).not.toBeInTheDocument(); // no new tab under the dialog
    expect(seams.attach).toHaveBeenCalledTimes(2);

    fireEvent.click(dialogButton("Cancel"));
    act(() => seams.tabsAction.fire("new"));
    expect(screen.getByTestId("tab-2")).toBeInTheDocument(); // the menu verb works again
  });

  it("the quit dialog reports how many tabs have running programs", async () => {
    const seams = renderApp();
    await resolveAttach(seams.calls[0], { sessionId: 11, title: "one" });
    cmdT();
    await resolveAttach(seams.calls[1], { sessionId: 12, title: "two" });
    act(() => seams.activity.fire(11, true));
    act(() => seams.activity.fire(12, true));

    act(() => seams.closeRequested.fire());

    expect(dialog()).toHaveTextContent("2 tabs have running programs.");
  });

  it("target drift A: the pane going IDLE does not dismiss the dialog; confirm still closes it", async () => {
    const seams = renderApp();
    await splitWithBusyPane2(seams);
    cmdW();

    act(() => seams.activity.fire(22, false)); // the job finished while the dialog was up

    expect(dialog()).toBeInTheDocument(); // stays open — the user answers the question they saw
    fireEvent.click(dialogButton("Close"));
    expect(screen.queryByTestId("pane-host-2")).not.toBeInTheDocument();
    expect(seams.closeSession).toHaveBeenCalledExactlyOnceWith(22);
  });

  it("target drift B: the pane EXITING makes confirm a safe no-op (no wrong-target close)", async () => {
    const seams = renderApp();
    await splitWithBusyPane2(seams);
    cmdW();

    act(() => seams.ptyExited.fire(22)); // the prompted pane died under the dialog

    expect(screen.queryByTestId("pane-host-2")).not.toBeInTheDocument();
    fireEvent.click(dialogButton("Close"));
    expect(dialog()).toBeNull();
    expect(screen.getByTestId("pane-host-1")).toBeInTheDocument(); // the survivor is untouched
    expect(seams.closeSession).not.toHaveBeenCalled();
    expect(seams.closeWindow).not.toHaveBeenCalled();
  });

  it("don't-ask-again persists terminal.confirmClose=never AND the close proceeds", async () => {
    const seams = renderApp();
    await splitWithBusyPane2(seams);
    cmdW();

    fireEvent.click(within(screen.getByTestId("confirm-close")).getByRole("checkbox"));
    fireEvent.click(dialogButton("Close"));

    expect(makeSettingsStore().get("terminal.confirmClose")).toBe("never");
    expect(screen.queryByTestId("pane-host-2")).not.toBeInTheDocument();
    expect(seams.closeSession).toHaveBeenCalledExactlyOnceWith(22);

    // The persisted "never" holds: a busy close now proceeds without a prompt.
    act(() => seams.activity.fire(11, true));
    cmdW();
    expect(dialog()).toBeNull();
    expect(seams.closeWindow).toHaveBeenCalledTimes(1); // last pane → last tab → window
  });
});

describe("confirm-before-close: the tab gate (trmx-144)", () => {
  it("the tab-strip × on a tab with a busy pane prompts with THAT pane's name; confirm closes the whole tab", async () => {
    const seams = renderApp();
    // Tab 1: panes 1 (session 11, busy, running "vim") + 2 (session 22, idle). Tab 2: pane 3.
    await resolveAttach(seams.calls[0], { sessionId: 11, title: "one" });
    cmdD();
    await resolveAttach(seams.calls[1], { sessionId: 22, title: "two" });
    fireEvent.click(screen.getByTestId("tab-new"));
    await resolveAttach(seams.calls[2], { sessionId: 33, title: "three" });
    act(() => seams.activity.fire(11, true));
    await act(async () => seams.titleHint.fire(11, "vim"));

    fireEvent.click(screen.getByTestId("tab-close-1"));

    expect(dialog()).toBeInTheDocument();
    expect(dialog()).toHaveTextContent("Close this tab?");
    expect(dialog()).toHaveTextContent("vim is still running.");
    expect(screen.getByTestId("tab-1")).toBeInTheDocument(); // NOT closed yet

    fireEvent.click(dialogButton("Close Tab"));
    expect(screen.queryByTestId("tab-1")).not.toBeInTheDocument();
    expect(seams.closeSession).toHaveBeenCalledTimes(2); // both of tab 1's panes
    expect(seams.closeSession).toHaveBeenCalledWith(11);
    expect(seams.closeSession).toHaveBeenCalledWith(22);
  });
});

describe("confirm-before-close: the quit gate (trmx-144)", () => {
  it("close:requested with a busy tab prompts; confirm calls quitConfirmed exactly once", async () => {
    const seams = renderApp();
    await resolveAttach(seams.calls[0], { sessionId: 11, title: "one" });
    act(() => seams.activity.fire(11, true));

    act(() => seams.closeRequested.fire());

    expect(dialog()).toBeInTheDocument();
    expect(dialog()).toHaveTextContent("Quit Termixion?");
    expect(seams.quitConfirmed).not.toHaveBeenCalled();

    fireEvent.click(dialogButton("Quit"));
    expect(dialog()).toBeNull();
    expect(seams.quitConfirmed).toHaveBeenCalledTimes(1);
  });

  it("close:requested with a busy tab: cancel never calls quitConfirmed", async () => {
    const seams = renderApp();
    await resolveAttach(seams.calls[0], { sessionId: 11, title: "one" });
    act(() => seams.activity.fire(11, true));

    act(() => seams.closeRequested.fire());
    fireEvent.click(dialogButton("Cancel"));

    expect(dialog()).toBeNull();
    expect(seams.quitConfirmed).not.toHaveBeenCalled();
    expect(screen.getByTestId("pane-host-1")).toBeInTheDocument();
  });

  it("close:requested with everything idle confirms the quit immediately (no dialog)", async () => {
    const seams = renderApp();
    await resolveAttach(seams.calls[0], { sessionId: 11, title: "one" });

    act(() => seams.closeRequested.fire());

    expect(dialog()).toBeNull();
    expect(seams.quitConfirmed).toHaveBeenCalledTimes(1);
  });

  it("a REMOTE window.close confirms the quit directly — no dialog, no native close", async () => {
    const seams = renderApp();
    await resolveAttach(seams.calls[0], { sessionId: 11, title: "one" });
    act(() => seams.activity.fire(11, true));
    setConfirmClose("always");

    act(() => seams.controlRequest.fire({ id: 2, request: { cmd: "window.close" } }));

    expect(dialog()).toBeNull();
    expect(seams.quitConfirmed).toHaveBeenCalledTimes(1);
    expect(seams.closeWindow).not.toHaveBeenCalled();
  });

  it("close:requested after an authorized last-tab close quits immediately (no second prompt)", async () => {
    const seams = renderApp();
    await resolveAttach(seams.calls[0], { sessionId: 11, title: "one" });

    cmdW(); // idle pane → last pane → last tab → the gated gesture reaches closeWindow
    expect(seams.closeWindow).toHaveBeenCalledTimes(1);

    act(() => seams.closeRequested.fire()); // the backend round-trips the native close

    expect(dialog()).toBeNull();
    expect(seams.quitConfirmed).toHaveBeenCalledTimes(1);
  });
});
