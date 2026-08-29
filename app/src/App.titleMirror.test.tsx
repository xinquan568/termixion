// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-243 (grill L6): App issues NO `set_session_title` IPC.
//
// The core title mirror wrote every attached pane's effective title into `Session::title` over an
// IPC per change — and nothing ever read it back. `SessionRegistry::title()` had no production
// caller; the control protocol's `ls` snapshot is assembled frontend-side in `controlBridge.ts`.
// Deleting the mirror is a behavioural change, so it owes a test that SURVIVES the deletion rather
// than the mere removal of the old mirror's tests: this pins the absence, so a future title path
// cannot quietly reintroduce a write-only IPC.
//
// The assertion is a first-argument predicate, NOT `expect(spy).not.toHaveBeenCalledWith(cmd)` —
// Vitest compares the WHOLE argument array, and the real call was `invoke("set_session_title",
// { sessionId, title })`, so a one-argument negative assertion would have passed vacuously and the
// test would never have been red.
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./terminal/TerminalView", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalView: ({ onReady }: { onReady?: (h: unknown) => void }) => {
      useEffect(() => {
        onReady?.({
          terminal: { focus: vi.fn() },
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
  UpdateAuthorityHost: () => <div data-testid="uah" />,
}));

// `vi.hoisted` is load-bearing: vi.mock's factory is hoisted above the imports, so a plain
// top-level const would be in the temporal dead zone. `Channel` is stubbed because the factory
// replaces the whole module and `ipc/backend.ts` imports it alongside `invoke`.
const invokeSpy = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    void args;
    return Promise.resolve(null);
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeSpy, Channel: class {} }));

import { App, type AppProps } from "./App";
import { __resetSettingsForTest } from "./settings/settingsStore";
import type { SessionInfo } from "./ipc/backend";

function obs<T>() {
  return vi.fn((_h: (v: T) => void) => {
    void _h;
    return vi.fn();
  });
}

/** The title-hint seam, captured so the test can drive a real title change through App. */
function makeHintObservation() {
  let handler: ((sessionId: number, name: string) => void) | undefined;
  const observe = vi.fn((h: (sessionId: number, name: string) => void) => {
    handler = h;
    return vi.fn();
  });
  return {
    observe,
    fire: (sessionId: number, name: string) => handler?.(sessionId, name),
  };
}

beforeEach(() => {
  __resetSettingsForTest();
  invokeSpy.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("App × the core title mirror (trmx-243 L6)", () => {
  it("issues no set_session_title IPC when an attached pane's title changes", async () => {
    const titleHint = makeHintObservation();
    let resolveAttach: ((info: SessionInfo) => void) | undefined;
    const attach = vi.fn(
      () =>
        new Promise<SessionInfo>((resolve) => {
          resolveAttach = resolve;
        }),
    );

    // NOTE: `mirrorTitle` is deliberately NOT passed. App then falls back to its production
    // default, which reaches the module-level `invoke` mocked above — that is what makes this
    // test observe the real IPC edge rather than an injected stub.
    render(
      <App
        attach={attach as unknown as AppProps["attach"]}
        closeWindow={vi.fn()}
        closeSession={vi.fn(() => Promise.resolve())}
        observeTabsAction={obs<unknown>()}
        observePtyExited={obs<number>()}
        observeTitleHint={
          titleHint.observe as unknown as AppProps["observeTitleHint"]
        }
        observeActivity={vi.fn(() => vi.fn()) as unknown as AppProps["observeActivity"]}
        observeSettings={obs<unknown>()}
        setWindowTitle={vi.fn()}
        installHotReload={vi.fn(() => vi.fn())}
      />,
    );

    await waitFor(() => expect(resolveAttach).toBeTypeOf("function"));
    await act(async () => {
      resolveAttach?.({ sessionId: 11, title: "zsh" });
    });

    // A foreground-process hint changes the pane's effective title — the exact edge the mirror
    // used to write through.
    await act(async () => {
      titleHint.fire(11, "vim");
    });

    const commands = invokeSpy.mock.calls.map((call) => call[0]);
    expect(commands).not.toContain("set_session_title");
  });
});
