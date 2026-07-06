// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94 (FR-9, test-first): App's command-platform integration — a webview chord resolves through
// the keymap → dispatch (⇧⌘P opens the palette keyboard-only; ⌘D splits); the guard rails hold
// (⌘C/⌘V and native-menu chords are NOT intercepted; a focused non-terminal editable is inert).
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./terminal/TerminalView", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalView: ({ onReady }: { onReady?: (h: unknown) => void }) => {
      useEffect(() => {
        onReady?.({ terminal: { focus: vi.fn() }, renderer: "dom", fit: () => {}, dispose: () => {} });
      }, [onReady]);
      return <div data-testid="terminal-view-stub" />;
    },
  };
});
vi.mock("./ipc/useBackend", () => ({ useBackend: () => ({ coreVersion: "0.0.2", attachTerminal: vi.fn() }) }));
vi.mock("./update/UpdateAuthorityHost", () => ({ UpdateAuthorityHost: () => <div data-testid="uah" /> }));

import { App, type AppProps } from "./App";
import { __resetSettingsForTest } from "./settings/settingsStore";
import type { SessionInfo } from "./ipc/backend";

interface AttachCall {
  resolve: (info: SessionInfo) => void;
  reject: (reason?: unknown) => void;
}
function makeAttach() {
  const calls: AttachCall[] = [];
  const attach = vi.fn(() => new Promise<SessionInfo>((resolve, reject) => calls.push({ resolve, reject })));
  return { attach, calls };
}
function obs<T>() {
  return { observe: vi.fn((_handler: (v: T) => void) => { void _handler; return vi.fn(); }) };
}
function renderApp(over: Partial<AppProps> = {}) {
  const { attach, calls } = makeAttach();
  render(
    <App
      attach={attach}
      closeWindow={vi.fn()}
      closeSession={vi.fn(() => Promise.resolve())}
      observeTabsAction={obs<unknown>().observe}
      observePtyExited={obs<number>().observe}
      observeTitleHint={vi.fn(() => vi.fn()) as unknown as AppProps["observeTitleHint"]}
      observeActivity={vi.fn(() => vi.fn()) as unknown as AppProps["observeActivity"]}
      observeSettings={obs<unknown>().observe}
      setWindowTitle={vi.fn()}
      mirrorTitle={vi.fn(() => Promise.resolve())}
      installHotReload={vi.fn(() => vi.fn())}
      {...over}
    />,
  );
  return { calls };
}

// Dispatch a window keydown (capture phase, like the real handler). target defaults to document.body.
function key(k: string, mods: Partial<KeyboardEventInit> = {}, target?: Element) {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
  (target ?? document.body).dispatchEvent(ev);
  return ev;
}

beforeEach(() => __resetSettingsForTest());
afterEach(() => vi.restoreAllMocks());

describe("App command platform (trmx-94)", () => {
  it("⇧⌘P opens the command palette (keyboard-only)", async () => {
    renderApp();
    await waitFor(() => expect(screen.getByTestId("terminal-view-stub")).toBeInTheDocument());
    expect(screen.queryByTestId("command-palette")).toBeNull();
    act(() => {
      key("p", { metaKey: true, shiftKey: true });
    });
    expect(await screen.findByTestId("command-palette")).toBeInTheDocument();
  });

  it("⌘D resolves to pane.split-right and creates a second pane", async () => {
    const { calls } = renderApp();
    await waitFor(() => expect(calls.length).toBe(1)); // first pane
    act(() => {
      key("d", { metaKey: true });
    });
    await waitFor(() => expect(calls.length).toBe(2)); // the split created a new pane
  });

  it("⌘C / ⌘V are NOT intercepted (clipboard guard) — no palette, event not prevented", () => {
    renderApp();
    const c = key("c", { metaKey: true });
    const v = key("v", { metaKey: true });
    expect(c.defaultPrevented).toBe(false);
    expect(v.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it("⌘T opens a new tab via the webview keymap (macOS arbitrates the native accelerator in packaged)", async () => {
    const { calls } = renderApp();
    await waitFor(() => expect(calls.length).toBe(1)); // first tab's pane
    const t = key("t", { metaKey: true });
    expect(t.defaultPrevented).toBe(true); // resolved → handled
    await waitFor(() => expect(calls.length).toBe(2)); // the new tab's pane attaches
  });

  it("a chord typed into a focused non-terminal input is inert", () => {
    renderApp();
    const input = document.createElement("input");
    document.body.appendChild(input);
    const ev = key("p", { metaKey: true, shiftKey: true }, input);
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("command-palette")).toBeNull();
    input.remove();
  });
});
