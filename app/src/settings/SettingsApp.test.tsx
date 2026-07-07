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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { clearUserThemes, type UserThemeEntry } from "../theme/registry";
import type { ThemeSpec } from "../theme/themeDerive";
import type { AnsiPalette } from "../theme/tokens";
import type { InvokeFn } from "../ipc/backend";

// --- trmx-89 (4b) user-theme fixtures (mirror registry.test.ts's spec/entry helpers) ---
const ANSI: AnsiPalette = {
  black: "#000000", red: "#ff0000", green: "#00ff00", yellow: "#ffff00",
  blue: "#0000ff", magenta: "#ff00ff", cyan: "#00ffff", white: "#ffffff",
  brightBlack: "#808080", brightRed: "#ff8080", brightGreen: "#80ff80", brightYellow: "#ffff80",
  brightBlue: "#8080ff", brightMagenta: "#ff80ff", brightCyan: "#80ffff", brightWhite: "#f0f6fc",
};

function validSpec(): ThemeSpec {
  return {
    isDark: true,
    color: { bg: { primary: "#000000" }, text: { primary: "#ffffff" }, accent: {}, semantic: {} },
    terminal: { ansi: { ...ANSI }, scrollbar: {}, pane: {} },
  };
}

function validUserEntry(id: string): UserThemeEntry {
  return { id, source: "user", valid: true, spec: validSpec(), warnings: [] };
}

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
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
  count: (event: string) => number;
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
    count: (event) => handlers.get(event)?.size ?? 0,
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
      openConfigFile={async () => {}}
      {...props}
    />,
  );
}

describe("SettingsApp shell", () => {
  it("puts Appearance FIRST in the nav, applies the persisted theme's vars on mount, and re-themes on a swatch click (trmx-53)", () => {
    renderApp();
    const nav = screen.getAllByRole("button", { name: /Appearance|Terminal|Scripts|About/ });
    expect(nav.map((b) => b.textContent)).toEqual([
      "Appearance",
      "Terminal",
      "Scripts",
      "About",
    ]);
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
    // The radio ring AND the applied `--tx-bg` swatch move together — assert BOTH inside the waitFor so a
    // slow runner can't observe the radio after it flips but before the CSS var catches up (a test race).
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Paper" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("radio", { name: "Night" })).toHaveAttribute("aria-checked", "false");
      expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#EEEDED");
    });
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

// trmx-82 (FR-2.3, test-first): the D5 lift — the shell owns a live `barPosition` state (seeded
// from the injected store, kept current by the SAME payload-guarded settings:changed subscription
// the theme uses) and hands it to AppearanceSettings, whose Orientation row it gates.
describe("SettingsApp — live barPosition for the Appearance page (trmx-82, D5)", () => {
  const ORIENTATION_GROUP = { name: "Tab label orientation" } as const;

  it("seeds barPosition from the injected store: a persisted 'left' selects Left and enables Orientation", () => {
    const settings = makeSettingsStore(fakeStorage({ "termixion.tabs.barPosition": "left" }));
    render(
      <SettingsApp
        update={fakeUpdate()}
        appInfo={makeFakeAppInfo("0.0.1")}
        opener={makeFakeOpener()}
        settings={settings}
        openConfigFile={async () => {}}
        initialSection="appearance"
      />,
    );
    expect(screen.getByRole("radio", { name: "Left" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radiogroup", ORIENTATION_GROUP)).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("re-renders the page when an EXTERNAL settings:changed moves the bar; junk is inert", async () => {
    const bus = fakeListen();
    renderApp({ listen: bus.listen, initialSection: "appearance" });
    // The registry default (bottom) gates the Orientation row off.
    expect(screen.getByRole("radiogroup", ORIENTATION_GROUP)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await waitFor(() => expect(bus.count("settings:changed")).toBeGreaterThan(0));

    // A cross-window write / config-file edit moves the bar: the page follows live.
    bus.deliver("settings:changed", { key: "tabs.barPosition", value: "left", source: "main" });
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Left" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("radiogroup", ORIENTATION_GROUP)).not.toHaveAttribute(
        "aria-disabled",
      );
    });

    // Junk values and junk payloads are inert (untrusted input).
    bus.deliver("settings:changed", { key: "tabs.barPosition", value: "middle", source: "main" });
    bus.deliver("settings:changed", "garbage");
    bus.deliver("settings:changed", { key: "tabs.barPosition" });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Left" })).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("a local Position click flips the Orientation gate live (the busless onBarPositionChange path)", () => {
    renderApp({ initialSection: "appearance" });
    expect(screen.getByRole("radiogroup", ORIENTATION_GROUP)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: "Tab bar position" })).getByRole("radio", {
        name: "Left",
      }),
    );
    expect(screen.getByRole("radiogroup", ORIENTATION_GROUP)).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("tears the subscription down on unmount (a late delivery reaches no handler)", async () => {
    const bus = fakeListen();
    const { unmount } = renderApp({ listen: bus.listen, initialSection: "appearance" });
    await waitFor(() => expect(bus.count("settings:changed")).toBeGreaterThan(0));

    unmount();
    expect(bus.count("settings:changed")).toBe(0);
    expect(bus.count(SETTINGS_NAVIGATE_EVENT)).toBe(0);
    // A post-unmount delivery must be inert — nothing left to receive it, nothing throws.
    bus.deliver("settings:changed", { key: "tabs.barPosition", value: "left", source: "main" });
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

// trmx-89 (4b, test-first): the settings window owns its own registry instance, so the shell must
// hydrate the user themes on mount (the Appearance picker lists from it) and re-hydrate live when a
// `themes:changed` file-watch signal fires. Both go through the injected invoke + listen seams.
describe("SettingsApp — user themes hydration (trmx-89, 4b)", () => {
  beforeEach(() => clearUserThemes());
  afterEach(() => clearUserThemes());

  function renderWithThemes(invoke: InvokeFn, listen: ReturnType<typeof fakeListen>["listen"]) {
    return render(
      <SettingsApp
        update={fakeUpdate()}
        appInfo={makeFakeAppInfo("0.0.1")}
        opener={makeFakeOpener()}
        settings={makeSettingsStore(fakeStorage())}
        openConfigFile={async () => {}}
        listen={listen}
        invoke={invoke}
        initialSection="appearance"
      />,
    );
  }

  const themesReadCount = (invoke: ReturnType<typeof vi.fn>) =>
    invoke.mock.calls.filter((c) => c[0] === "themes_read").length;

  it("hydrates the user themes on mount (invoke reads themes_read) and lists them in the picker", async () => {
    const bus = fakeListen();
    const invoke = vi
      .fn<InvokeFn>()
      .mockImplementation((cmd) =>
        Promise.resolve(cmd === "themes_read" ? [validUserEntry("user:cool")] : null),
      );
    renderWithThemes(invoke, bus.listen);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("themes_read"));
    // After the registry hydrates and the shell bumps, the user theme lists in the Theme picker.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Cool" })).toBeInTheDocument(),
    );
  });

  // trmx-89 review-1: the highest-risk integration path — a user theme surfaced by themes_read, once
  // selected, actually APPLIES its colors end-to-end (service -> registry -> picker -> apply). "Cool"
  // is spec(true,"#000000","#ffffff"), so its derived --tx-bg is #000000.
  it("selecting a hydrated user theme applies its colors to the settings surface", async () => {
    const bus = fakeListen();
    const invoke = vi
      .fn<InvokeFn>()
      .mockImplementation((cmd) =>
        Promise.resolve(cmd === "themes_read" ? [validUserEntry("user:cool")] : null),
      );
    renderWithThemes(invoke, bus.listen);

    const swatch = await screen.findByRole("radio", { name: "Cool" });
    fireEvent.click(swatch);
    // The shell's applyTxTheme(theme) effect painted the user theme's background onto documentElement.
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#000000"),
    );
  });

  // An INVALID user theme from themes_read is LISTED but inert — no radio role, an "invalid" badge.
  it("lists an invalid user theme as inert with an invalid badge (not selectable)", async () => {
    const bus = fakeListen();
    const invoke = vi.fn<InvokeFn>().mockImplementation((cmd) =>
      Promise.resolve(
        cmd === "themes_read"
          ? [
              {
                id: "user:broken",
                source: "user",
                valid: false,
                spec: null,
                warnings: [{ type: "MissingRequired", key: "color.text.primary" }],
              },
            ]
          : null,
      ),
    );
    renderWithThemes(invoke, bus.listen);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("themes_read"));
    // It shows up (an "invalid" badge is rendered) but NOT as a selectable radio.
    await waitFor(() => expect(screen.getByText("invalid")).toBeInTheDocument());
    expect(screen.queryByRole("radio", { name: "Broken" })).toBeNull();
  });

  // Duplicate-a-builtin writes a full-token TOML body (themes_write) that carries the parser's grammar
  // — the zero-warning round-trip itself is pinned by the core golden/example tests + the serializer's
  // shape-parity test; here we verify the integration wiring calls themes_write with a real body.
  it("Duplicate on a built-in writes a full-token TOML body via themes_write", async () => {
    const bus = fakeListen();
    const writes: Array<{ stem: unknown; text: unknown }> = [];
    const invoke = vi.fn<InvokeFn>().mockImplementation((cmd, args) => {
      if (cmd === "themes_read") return Promise.resolve([]);
      if (cmd === "themes_write") {
        writes.push(args as { stem: unknown; text: unknown });
        return Promise.resolve(`/themes/${(args as { stem: string }).stem}.toml`);
      }
      return Promise.resolve(null);
    });
    renderWithThemes(invoke, bus.listen);

    const dupNight = await screen.findByRole("button", { name: "Duplicate Night" });
    fireEvent.click(dupNight);

    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].stem).toBe("night-copy");
    const body = writes[0].text as string;
    expect(body).toContain("is_dark = true");
    expect(body).toContain("[terminal.ansi]");
    expect(body).toContain("[color.bg]");
  });

  it("re-hydrates on a themes:changed event (invoke reads themes_read again)", async () => {
    const bus = fakeListen();
    const invoke = vi.fn<InvokeFn>().mockResolvedValue([]);
    renderWithThemes(invoke, bus.listen);

    // The mount read happened, and the shell subscribed to themes:changed.
    await waitFor(() => expect(themesReadCount(invoke)).toBeGreaterThan(0));
    await waitFor(() => expect(bus.count("themes:changed")).toBeGreaterThan(0));
    const before = themesReadCount(invoke);

    // A dropped/edited/removed theme file → the shell re-reads and re-registers.
    bus.deliver("themes:changed", null);
    await waitFor(() => expect(themesReadCount(invoke)).toBeGreaterThan(before));
  });

  it("tears the themes:changed subscription down on unmount", async () => {
    const bus = fakeListen();
    const invoke = vi.fn<InvokeFn>().mockResolvedValue([]);
    const { unmount } = renderWithThemes(invoke, bus.listen);
    await waitFor(() => expect(bus.count("themes:changed")).toBeGreaterThan(0));

    unmount();
    expect(bus.count("themes:changed")).toBe(0);
    // A post-unmount delivery must be inert (nothing left to receive it, no throw, no re-read).
    const before = themesReadCount(invoke);
    bus.deliver("themes:changed", null);
    expect(themesReadCount(invoke)).toBe(before);
  });
});
