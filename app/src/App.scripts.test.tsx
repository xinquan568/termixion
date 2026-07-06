// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-93 (FR-5, test-first): App's scripting orchestration — the source-on-attach send path, the
// race-free startup ordering (a script survives even when attach resolves before listScripts does),
// startup fail-soft (a missing script sources nothing + warns), and the "…with Script…" verbs
// opening the picker. Uses the App.test controllable-attach harness so the test decides WHEN the
// backend answers, which is exactly what the race case needs.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub TerminalView (mirrors App.test.tsx): a real xterm mount needs matchMedia/canvas the jsdom
// env lacks. The stub fires onReady with a fake handle, which drives App's attach path.
vi.mock("./terminal/TerminalView", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalView: ({ onReady }: { onReady?: (handle: unknown) => void }) => {
      useEffect(() => {
        onReady?.({ terminal: { focus: vi.fn() }, renderer: "dom", fit: () => {}, dispose: () => {} });
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

import { App, type AppProps } from "./App";
import { makeSettingsStore, __resetSettingsForTest } from "./settings/settingsStore";
import type { InvokeFn, SessionInfo } from "./ipc/backend";

const ENTRY = {
  relPath: "work/proj-x.sh",
  name: "proj-x",
  sourceLine: "source '/x/work/proj-x.sh'",
};

interface AttachCall {
  resolve: (info: SessionInfo) => void;
  reject: (reason?: unknown) => void;
}

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

function makeObservation<T>() {
  let handler: ((value: T) => void) | undefined;
  const observe = vi.fn((h: (value: T) => void) => {
    handler = h;
    return vi.fn();
  });
  return { observe, fire: (value: T) => handler?.(value) };
}

function renderScriptsApp(over: Partial<AppProps>) {
  const { attach, calls } = makeAttach();
  const tabsAction = makeObservation<unknown>();
  const props: AppProps = {
    attach,
    closeWindow: vi.fn(),
    closeSession: vi.fn(() => Promise.resolve()),
    observeTabsAction: tabsAction.observe,
    observePtyExited: makeObservation<number>().observe,
    observeTitleHint: vi.fn(() => vi.fn()) as unknown as AppProps["observeTitleHint"],
    observeActivity: vi.fn(() => vi.fn()) as unknown as AppProps["observeActivity"],
    observeSettings: makeObservation<unknown>().observe,
    setWindowTitle: vi.fn(),
    mirrorTitle: vi.fn(() => Promise.resolve()),
    installHotReload: vi.fn(() => vi.fn()),
    ...over,
  };
  render(<App {...props} />);
  return { calls, tabsAction };
}

beforeEach(() => __resetSettingsForTest());
afterEach(() => vi.restoreAllMocks());

describe("App scripting orchestration (trmx-93)", () => {
  it("sources the startup script on the first pane's attach", async () => {
    makeSettingsStore().set("scripts.startup", "work/proj-x.sh");
    const invoke = vi.fn(async (cmd: string) =>
      cmd === "scripts_list" ? [ENTRY] : undefined,
    ) as unknown as InvokeFn;
    const sendInput = vi.fn(() => Promise.resolve());
    const { calls } = renderScriptsApp({ invoke, sendInput });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0].resolve({ sessionId: 7, title: "zsh" }));
    await waitFor(() =>
      expect(sendInput).toHaveBeenCalledWith(7, "source '/x/work/proj-x.sh'\r"),
    );
  });

  it("does not lose the startup script when attach resolves BEFORE listScripts (race)", async () => {
    makeSettingsStore().set("scripts.startup", "work/proj-x.sh");
    let resolveList: ((v: unknown) => void) | undefined;
    const invoke = vi.fn(
      () => new Promise((resolve) => { resolveList = resolve; }),
    ) as unknown as InvokeFn;
    const sendInput = vi.fn(() => Promise.resolve());
    const { calls } = renderScriptsApp({ invoke, sendInput });
    await waitFor(() => expect(calls.length).toBe(1));
    // Attach resolves FIRST — the startup catalog is still in flight.
    act(() => calls[0].resolve({ sessionId: 7, title: "zsh" }));
    await Promise.resolve();
    expect(sendInput).not.toHaveBeenCalled();
    // Now the catalog lands: the awaited pending promise still sends the script.
    act(() => resolveList?.([ENTRY]));
    await waitFor(() =>
      expect(sendInput).toHaveBeenCalledWith(7, "source '/x/work/proj-x.sh'\r"),
    );
  });

  it("sources nothing and warns when the configured startup script is missing", async () => {
    makeSettingsStore().set("scripts.startup", "gone.sh");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoke = vi.fn(async () => [ENTRY]) as unknown as InvokeFn; // only work/proj-x.sh exists
    const sendInput = vi.fn(() => Promise.resolve());
    const { calls } = renderScriptsApp({ invoke, sendInput });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0].resolve({ sessionId: 7, title: "zsh" }));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("sources nothing when no startup script is configured", async () => {
    const invoke = vi.fn(async () => []) as unknown as InvokeFn;
    const sendInput = vi.fn(() => Promise.resolve());
    const { calls } = renderScriptsApp({ invoke, sendInput });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0].resolve({ sessionId: 7, title: "zsh" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(sendInput).not.toHaveBeenCalled();
    // no startup → never asks for the SCRIPTS catalog (trmx-94: App does call keys_read on mount).
    expect(invoke).not.toHaveBeenCalledWith("scripts_list");
  });

  it("a new-with-script verb opens the picker; Esc closes it", async () => {
    const invoke = vi.fn(async () => [ENTRY]) as unknown as InvokeFn;
    const { tabsAction } = renderScriptsApp({ invoke, sendInput: vi.fn(() => Promise.resolve()) });
    expect(screen.queryByTestId("script-picker")).toBeNull();
    act(() => tabsAction.fire("new-with-script"));
    expect(await screen.findByTestId("script-picker")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("script-picker"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("script-picker")).toBeNull());
  });

  // The full picker → pick → run path for each surface verb: pick a script, resolve the NEW pane's
  // attach, and assert it is sourced. (The first pane is calls[0]; the scripted surface is calls[1].)
  it.each([
    ["new-with-script"],
    ["split-right-with-script"],
    ["split-below-with-script"],
  ])("%s: picking a script sources it in the new surface", async (verb) => {
    const invoke = vi.fn(async () => [ENTRY]) as unknown as InvokeFn;
    const sendInput = vi.fn(() => Promise.resolve());
    const { calls, tabsAction } = renderScriptsApp({ invoke, sendInput });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0].resolve({ sessionId: 1, title: "zsh" })); // first pane, no script

    act(() => tabsAction.fire(verb));
    const picker = await screen.findByTestId("script-picker");
    await screen.findByText("work/proj-x.sh"); // catalog loaded into the picker
    fireEvent.keyDown(picker, { key: "Enter" }); // run the highlighted entry

    await waitFor(() => expect(calls.length).toBe(2)); // the new surface's pane attaches
    act(() => calls[1].resolve({ sessionId: 2, title: "zsh" }));
    await waitFor(() =>
      expect(sendInput).toHaveBeenCalledWith(2, "source '/x/work/proj-x.sh'\r"),
    );
    // Exactly the new surface was sourced — the first pane never was.
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it("a scripted tab closed BEFORE its attach resolves is never sourced (no stale pending)", async () => {
    const invoke = vi.fn(async () => [ENTRY]) as unknown as InvokeFn;
    const sendInput = vi.fn(() => Promise.resolve());
    const { calls, tabsAction } = renderScriptsApp({ invoke, sendInput });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0].resolve({ sessionId: 1, title: "zsh" }));

    act(() => tabsAction.fire("new-with-script"));
    await screen.findByTestId("script-picker");
    await screen.findByText("work/proj-x.sh");
    fireEvent.keyDown(screen.getByTestId("script-picker"), { key: "Enter" });
    await waitFor(() => expect(calls.length).toBe(2)); // the scripted tab's pane mounted...

    act(() => tabsAction.fire("close")); // ...then it is closed before attach resolves
    act(() => calls[1].resolve({ sessionId: 2, title: "zsh" })); // the now-orphan attach lands
    await Promise.resolve();
    await Promise.resolve();
    expect(sendInput).not.toHaveBeenCalled(); // a dead pane sources nothing
  });
});
