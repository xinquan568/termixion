// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-238 (M19), step-8 finding 5: the badge's own suite covers the component in isolation, but
// the INTEGRATION is the point of the issue — config warnings were invisible from the terminal
// window because App never mounted a consumer. This pins that App puts the badge in the title bar
// and that clicking it actually opens Settings.
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
vi.mock("./ipc/useBackend", () => ({
  useBackend: () => ({ coreVersion: "0.0.2", attachTerminal: vi.fn() }),
}));
vi.mock("./update/UpdateAuthorityHost", () => ({
  UpdateAuthorityHost: () => <div data-testid="uah" />,
}));

const invokeSpy = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeSpy }));

import { App, type AppProps } from "./App";
import {
  CONFIG_WARNINGS_EVENT,
  __resetSettingsForTest,
  hydrateSettings,
} from "./store/settingsStore";
import type { SessionInfo } from "./ipc/backend";

function obs<T>() {
  return vi.fn((_h: (v: T) => void) => {
    void _h;
    return vi.fn();
  });
}

function fakeListenBus() {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  return {
    listen(event: string, handler: (p: unknown) => void) {
      const set = handlers.get(event) ?? new Set<(p: unknown) => void>();
      set.add(handler);
      handlers.set(event, set);
      return Promise.resolve(() => void set.delete(handler));
    },
    fire(event: string, payload: unknown) {
      for (const h of [...(handlers.get(event) ?? [])]) h(payload);
    },
  };
}

function renderApp(over: Partial<AppProps> = {}) {
  render(
    <App
      attach={vi.fn(() => new Promise<SessionInfo>(() => {}))}
      closeWindow={vi.fn()}
      closeSession={vi.fn(() => Promise.resolve())}
      observeTabsAction={obs<unknown>()}
      observePtyExited={obs<number>()}
      observeTitleHint={vi.fn(() => vi.fn()) as unknown as AppProps["observeTitleHint"]}
      observeActivity={vi.fn(() => vi.fn()) as unknown as AppProps["observeActivity"]}
      observeSettings={obs<unknown>()}
      setWindowTitle={vi.fn()}
      installHotReload={vi.fn(() => vi.fn())}
      {...over}
    />,
  );
}

beforeEach(() => {
  __resetSettingsForTest();
  invokeSpy.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("App × config warnings (trmx-238 M19)", () => {
  it("shows no badge in the title bar while the config file is clean", async () => {
    const bus = fakeListenBus();
    await hydrateSettings({
      invoke: () =>
        Promise.resolve({ exists: true, path: "/c.toml", values: {}, warnings: [] }),
      bus,
      storage: undefined,
    });
    renderApp();
    await waitFor(() => expect(screen.getByTestId("uah")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /open settings/i })).toBeNull();
  });

  it("surfaces a config:warnings broadcast in the title bar and opens Settings on click", async () => {
    const bus = fakeListenBus();
    await hydrateSettings({
      invoke: () =>
        Promise.resolve({ exists: true, path: "/c.toml", values: {}, warnings: [] }),
      bus,
      storage: undefined,
    });
    renderApp();
    await waitFor(() => expect(screen.getByTestId("uah")).toBeTruthy());

    act(() => {
      bus.fire(CONFIG_WARNINGS_EVENT, [
        { type: "SyntaxError", message: "unexpected end of input" },
      ]);
    });

    const badge = await screen.findByRole("button", { name: /open settings/i });
    // It lives in the title bar's right slot, not somewhere else in the tree.
    expect(badge.closest(".title-bar")).not.toBeNull();

    invokeSpy.mockClear();
    act(() => {
      badge.click();
    });
    await waitFor(() =>
      expect(invokeSpy).toHaveBeenCalledWith("open_settings_window", { section: null }),
    );
  });
});
