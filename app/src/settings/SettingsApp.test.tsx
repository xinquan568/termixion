// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the settings-window shell spec — vmark-style sidebar (search field + Terminal/About
// entries), page switching (nav clicks, initial section, settings:navigate events), the centered
// "Settings" title, and the data-tauri-drag-region chrome that makes an Overlay-titlebar window
// draggable. R8: written before the shell exists.
// trmx-80 (FR-13): the config-warnings banner — seeded from getConfigWarnings() at mount, kept
// current by config:warnings events (the store's subscription re-parses first — hydrateSettings
// subscribes before the shell renders, exactly the production boot order), dismissable.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsApp, SETTINGS_NAVIGATE_EVENT } from "./SettingsApp";
import { makeFakeAppInfo } from "../update/appInfo";
import { makeFakeOpener } from "../update/opener";
import {
  __resetSettingsForTest,
  CONFIG_WARNINGS_EVENT,
  hydrateSettings,
  makeSettingsStore,
  type KeyValueStore,
} from "./settingsStore";
import { initialUpdateState } from "../update/updateState";
import type { UseUpdate } from "../update/useUpdate";

function fakeStorage(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function fakeUpdate(): UseUpdate {
  return {
    state: initialUpdateState(true),
    checkNow: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    skip: vi.fn(),
    setAutoCheck: vi.fn(),
  };
}

type Handler = (payload: unknown) => void;

function fakeListen(): {
  listen: (event: string, handler: Handler) => Promise<() => void>;
  deliver: (event: string, payload: unknown) => void;
} {
  const handlers = new Map<string, Set<Handler>>();
  return {
    listen(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return Promise.resolve(() => void set.delete(handler));
    },
    deliver(event, payload) {
      for (const h of [...(handlers.get(event) ?? [])]) h(payload);
    },
  };
}

function renderApp(props: Partial<Parameters<typeof SettingsApp>[0]> = {}) {
  const settings = makeSettingsStore(fakeStorage());
  return render(
    <SettingsApp
      update={fakeUpdate()}
      appInfo={makeFakeAppInfo("0.0.1")}
      opener={makeFakeOpener()}
      settings={settings}
      {...props}
    />,
  );
}

describe("SettingsApp shell", () => {
  it("puts Appearance FIRST in the nav, applies the persisted theme's vars on mount, and re-themes on a swatch click (trmx-53)", () => {
    renderApp();
    const nav = screen.getAllByRole("button", { name: /Appearance|Terminal|About/ });
    expect(nav.map((b) => b.textContent)).toEqual(["Appearance", "Terminal", "About"]);
    // Mount applied the persisted theme (jsdom derivation → Night) to documentElement.
    expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#23262b");

    // Open the Appearance page and pick Sepia: the window re-derives its vars immediately
    // (local onThemeChange path — no bus required in plain dev).
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("radio", { name: "Sepia" }));
    expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#F9F0DB");
  });

  it("re-applies the theme on a settings:changed broadcast (About-page reset / cross-window), ignoring junk", async () => {
    const bus = fakeListen();
    renderApp({ listen: bus.listen });
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#23262b"),
    );

    bus.deliver("settings:changed", { key: "appearance.theme", value: "mint", source: "settings" });
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#CCE6D0"),
    );

    // Junk payloads and other keys are inert (untrusted input).
    bus.deliver("settings:changed", { key: "appearance.theme", value: "neon" });
    bus.deliver("settings:changed", "garbage");
    bus.deliver("settings:changed", { key: "terminal.cursorBlink", value: true });
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#CCE6D0"),
    );
  });

  it("moves the swatch selection when a broadcast lands while the Appearance page is open (step-9 F1)", async () => {
    const bus = fakeListen();
    renderApp({ listen: bus.listen, initialSection: "appearance" });
    // jsdom derivation → Night is selected initially.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Night" })).toHaveAttribute("aria-checked", "true"),
    );

    // An About-page reset / cross-window write re-selects the broadcast theme, ring included.
    bus.deliver("settings:changed", { key: "appearance.theme", value: "paper", source: "main" });
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Paper" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("radio", { name: "Night" })).toHaveAttribute("aria-checked", "false");
    });
    expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#EEEDED");
  });

  it("renders the sidebar with the search field and the Terminal + About entries", () => {
    renderApp();
    expect(screen.getByPlaceholderText("Search settings…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About" })).toBeInTheDocument();
  });

  it("lands on the Terminal page by default and marks its entry active", () => {
    renderApp();
    expect(screen.getByText("Cursor Style")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal" }).className).toContain(
      "tx-nav-item--active",
    );
  });

  it("lands on About when initialSection says so", () => {
    renderApp({ initialSection: "about" });
    expect(screen.getByText("Automatic updates")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About" }).className).toContain(
      "tx-nav-item--active",
    );
  });

  it("switches pages on nav clicks", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText("Automatic updates")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByText("Cursor Style")).toBeInTheDocument();
  });

  it("filters the nav entries by the search query", () => {
    renderApp();
    fireEvent.change(screen.getByPlaceholderText("Search settings…"), {
      target: { value: "ab" },
    });
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About" })).toBeInTheDocument();
  });

  it("navigates to Appearance on a settings:navigate event and rejects junk payloads (trmx-53)", async () => {
    const bus = fakeListen();
    renderApp({ listen: bus.listen });
    await waitFor(() => expect(bus.deliver).toBeDefined());

    bus.deliver(SETTINGS_NAVIGATE_EVENT, "appearance");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Appearance" }).className).toContain(
        "tx-nav-item--active",
      ),
    );

    // Junk payloads leave the section unchanged.
    bus.deliver(SETTINGS_NAVIGATE_EVENT, "nope");
    bus.deliver(SETTINGS_NAVIGATE_EVENT, 42);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Appearance" }).className).toContain(
        "tx-nav-item--active",
      ),
    );
  });

  it("navigates on a settings:navigate event (the About menu item path)", async () => {
    const bus = fakeListen();
    renderApp({ listen: bus.listen });
    await waitFor(() => {}); // let the subscription resolve
    bus.deliver(SETTINGS_NAVIGATE_EVENT, "about");
    await waitFor(() => expect(screen.getByText("Automatic updates")).toBeInTheDocument());
  });

  it("renders the centered Settings title and the drag-region chrome (movable window)", () => {
    const { container } = renderApp();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    const dragRegions = container.querySelectorAll("[data-tauri-drag-region]");
    expect(dragRegions.length).toBeGreaterThanOrEqual(3); // sidebar strip, content strip, title overlay
  });
});

// trmx-80 (FR-13): the config-warnings banner. These tests hydrate the module snapshot with a
// fake backend FIRST (the production boot order: hydrateSettings subscribes the store to the bus
// before the shell renders and subscribes), so delivering config:warnings updates the store's
// state before the shell's handler re-reads it.
describe("SettingsApp config warnings banner (trmx-80)", () => {
  beforeEach(() => __resetSettingsForTest());
  afterEach(() => __resetSettingsForTest());

  /** A T2 backend whose config_read carries `warnings`; every other command resolves null. */
  function fakeConfigInvoke(warnings: unknown[]) {
    return (cmd: string): Promise<unknown> => {
      if (cmd === "config_read") {
        return Promise.resolve({
          exists: true,
          path: "/tmp/termixion/config.toml",
          values: { "appearance.theme": "night" },
          warnings,
        });
      }
      return Promise.resolve(null);
    };
  }

  it("shows each hydration warning in a banner at the top of the window", async () => {
    const bus = fakeListen();
    await hydrateSettings({
      invoke: fakeConfigInvoke([
        { type: "UnknownKey", key: "terminal.zoom" },
        { type: "OutOfRange", key: "terminal.fontSize", got: 99, clamped_to: 72 },
      ]),
      bus,
    });
    renderApp({ listen: bus.listen });
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Config file warnings");
    expect(banner.textContent).toContain('Unknown setting "terminal.zoom" in the config file');
    expect(banner.textContent).toContain("clamped to 72");
  });

  it("renders no banner when there are no warnings", () => {
    renderApp();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("replaces the banner on a config:warnings event and CLEARS on an empty one", async () => {
    const bus = fakeListen();
    await hydrateSettings({
      invoke: fakeConfigInvoke([{ type: "UnknownKey", key: "old.key" }]),
      bus,
    });
    renderApp({ listen: bus.listen });
    expect(screen.getByRole("alert").textContent).toContain("old.key");

    // The file watcher re-parsed: the new set supersedes the old one wholesale.
    bus.deliver(CONFIG_WARNINGS_EVENT, [{ type: "UnknownKey", key: "new.key" }]);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("new.key");
      expect(screen.getByRole("alert").textContent).not.toContain("old.key");
    });

    // A clean re-parse (zero warnings) clears the banner.
    bus.deliver(CONFIG_WARNINGS_EVENT, []);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("shows the client warning when a live config-file edit carries an invalid theme", async () => {
    // trmx-80 review R1/R2: the backend cannot validate theme IDs, so the STORE authors the
    // warning client-side — and the banner must surface it (the store is the warnings authority,
    // not the raw config:warnings event, which never fires for client-authored warnings).
    const bus = fakeListen();
    await hydrateSettings({ invoke: fakeConfigInvoke([]), bus });
    renderApp({ listen: bus.listen });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    bus.deliver("settings:changed", {
      key: "appearance.theme",
      value: "nihgt",
      source: "config-file",
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("appearance.theme"),
    );
  });

  it("keeps the client warning through the backend's clean reparse; a valid value clears it", async () => {
    // trmx-80 review R2 (round 2): a hand edit with an invalid theme id makes the watcher emit
    // settings:changed (the client authors the warning) AND config:warnings [] — the core parsed
    // the file clean, since a theme is a free string to the backend. The empty FILE set must not
    // wipe the CLIENT warning; only a later valid value for the key clears it.
    const bus = fakeListen();
    await hydrateSettings({ invoke: fakeConfigInvoke([]), bus });
    renderApp({ listen: bus.listen });

    bus.deliver("settings:changed", {
      key: "appearance.theme",
      value: "nihgt",
      source: "config-file",
    });
    bus.deliver(CONFIG_WARNINGS_EVENT, []);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("appearance.theme"),
    );

    bus.deliver("settings:changed", {
      key: "appearance.theme",
      value: "mint",
      source: "config-file",
    });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("clears the banner once the user fixes the file (a clean reparse delivers ZERO warnings)", async () => {
    const bus = fakeListen();
    await hydrateSettings({
      invoke: fakeConfigInvoke([{ type: "UnknownKey", key: "typo.key" }]),
      bus,
    });
    renderApp({ listen: bus.listen });
    expect(screen.getByRole("alert").textContent).toContain("typo.key");

    // The watcher accepted the fixed file: an EMPTY warning set must clear the stale banner.
    bus.deliver(CONFIG_WARNINGS_EVENT, []);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("dismiss hides the banner until a new event arrives", async () => {
    const bus = fakeListen();
    await hydrateSettings({
      invoke: fakeConfigInvoke([{ type: "SyntaxError", message: "expected `=` at line 3" }]),
      bus,
    });
    renderApp({ listen: bus.listen });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss config warnings" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // A fresh re-parse with warnings resurfaces the banner.
    bus.deliver(CONFIG_WARNINGS_EVENT, [{ type: "UnknownKey", key: "fresh.key" }]);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("fresh.key"));
  });
});
