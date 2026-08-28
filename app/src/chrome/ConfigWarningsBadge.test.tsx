// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-238 (M19): the main-window badge for config-file warnings. Before this, `config:warnings`
// was consumed only by the settings window — a hand-edited typo in termixion.toml was completely
// invisible from the terminal window, which is where the user actually is.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { ConfigWarningsBadge } from "./ConfigWarningsBadge";
import {
  CONFIG_WARNINGS_EVENT,
  __resetSettingsForTest,
  hydrateSettings,
} from "../settings/settingsStore";

/** A listen-capable bus whose `fire` delivers synchronously, like the store's other tests use. */
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

const invoke = (cmd: string): Promise<unknown> => {
  if (cmd === "config_read")
    return Promise.resolve({ exists: true, path: "/c.toml", values: {}, warnings: [] });
  if (cmd === "config_write") return Promise.resolve(null);
  return Promise.resolve(null);
};

describe("ConfigWarningsBadge (trmx-238 M19)", () => {
  beforeEach(() => {
    __resetSettingsForTest();
  });

  it("renders nothing when there are no warnings", async () => {
    const bus = fakeListenBus();
    await hydrateSettings({ invoke, bus, storage: undefined });
    render(<ConfigWarningsBadge onOpenSettings={() => {}} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("appears when a config:warnings broadcast arrives, and counts them", async () => {
    const bus = fakeListenBus();
    await hydrateSettings({ invoke, bus, storage: undefined });
    render(<ConfigWarningsBadge onOpenSettings={() => {}} />);
    act(() => {
      bus.fire(CONFIG_WARNINGS_EVENT, [
        { type: "UnknownKey", key: "terminal.font_sise" },
        { type: "SyntaxError", message: "unexpected end of input" },
      ]);
    });
    const badge = screen.getByRole("button", { name: /open settings/i });
    expect(badge.textContent).toContain("2");
    expect(badge.getAttribute("title")).toContain("terminal.font_sise");
  });

  it("dismiss hides it, and the NEXT non-empty set brings it back", async () => {
    const bus = fakeListenBus();
    await hydrateSettings({ invoke, bus, storage: undefined });
    render(<ConfigWarningsBadge onOpenSettings={() => {}} />);
    act(() => {
      bus.fire(CONFIG_WARNINGS_EVENT, [{ type: "UnknownKey", key: "a" }]);
    });
    fireEvent.click(screen.getByLabelText(/dismiss/i));
    expect(screen.queryByRole("button", { name: /open settings/i })).toBeNull();

    // A fixed file broadcasts the EMPTY set — still nothing to show.
    act(() => {
      bus.fire(CONFIG_WARNINGS_EVENT, []);
    });
    expect(screen.queryByRole("button", { name: /open settings/i })).toBeNull();

    // A NEW problem must not stay hidden behind the old dismissal.
    act(() => {
      bus.fire(CONFIG_WARNINGS_EVENT, [{ type: "UnknownKey", key: "b" }]);
    });
    expect(screen.getByRole("button", { name: /open settings/i })).toBeTruthy();
  });

  it("clicking the badge opens Settings", async () => {
    const bus = fakeListenBus();
    await hydrateSettings({ invoke, bus, storage: undefined });
    const onOpenSettings = vi.fn();
    render(<ConfigWarningsBadge onOpenSettings={onOpenSettings} />);
    act(() => {
      bus.fire(CONFIG_WARNINGS_EVENT, [{ type: "UnknownKey", key: "a" }]);
    });
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
