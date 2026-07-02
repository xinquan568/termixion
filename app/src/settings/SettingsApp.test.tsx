// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the settings-window shell spec — vmark-style sidebar (search field + Terminal/About
// entries), page switching (nav clicks, initial section, settings:navigate events), the centered
// "Settings" title, and the data-tauri-drag-region chrome that makes an Overlay-titlebar window
// draggable. R8: written before the shell exists.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsApp, SETTINGS_NAVIGATE_EVENT } from "./SettingsApp";
import { makeFakeAppInfo } from "../update/appInfo";
import { makeFakeOpener } from "../update/opener";
import { makeSettingsStore, type KeyValueStore } from "./settingsStore";
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
