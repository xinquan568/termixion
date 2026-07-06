// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import { describe, expect, it, vi } from "vitest";
import { buildCommands, COMMAND_IDS, type CommandContext } from "./registry";

// A fake ctx recording every call — commands are pure over this, so no DOM is needed.
function fakeCtx(over: Partial<CommandContext> = {}): CommandContext {
  const noop = vi.fn();
  return {
    newTab: vi.fn(), closeActiveTab: vi.fn(), nextTab: vi.fn(), prevTab: vi.fn(),
    selectTab: vi.fn(), renameActiveTab: vi.fn(), newTabWithScript: vi.fn(),
    splitRight: vi.fn(), splitBelow: vi.fn(), splitRightWithScript: vi.fn(),
    splitBelowWithScript: vi.fn(), closePane: vi.fn(), focusPane: vi.fn(),
    nextPane: vi.fn(), prevPane: vi.fn(), setBadge: vi.fn(), growPane: vi.fn(),
    clearScrollback: vi.fn(), openSettings: vi.fn(), checkForUpdates: vi.fn(),
    openSearch: vi.fn(), searchNext: vi.fn(), searchPrev: vi.fn(), closeSearch: vi.fn(),
    closeWindow: vi.fn(), openCommandPalette: vi.fn(), selectTheme: vi.fn(), runScript: vi.fn(),
    tabCount: () => 5, paneCount: () => 3,
    ...over,
    _noop: noop,
  } as unknown as CommandContext;
}

const byId = (id: string) => buildCommands().find((c) => c.id === id)!;

describe("command registry — the frozen id set (stable public surface / FR-9.4 protocol)", () => {
  it("is exactly the enumerated command ids", () => {
    expect([...COMMAND_IDS].sort()).toEqual(
      [
        "tab.new", "tab.close", "tab.next", "tab.prev", "tab.rename", "tab.new-with-script",
        "tab.select-1", "tab.select-2", "tab.select-3", "tab.select-4", "tab.select-5",
        "tab.select-6", "tab.select-7", "tab.select-8", "tab.select-9",
        "pane.split-right", "pane.split-below", "pane.split-right-with-script",
        "pane.split-below-with-script", "pane.close", "pane.next", "pane.prev", "pane.set-badge",
        "pane.focus-left", "pane.focus-right", "pane.focus-up", "pane.focus-down",
        "pane.grow-left", "pane.grow-right", "pane.grow-up", "pane.grow-down",
        "terminal.clear-scrollback", "theme.select", "script.run",
        "search.open", "search.next", "search.prev", "search.close",
        "app.command-palette", "app.settings", "app.check-updates", "window.close",
      ].sort(),
    );
  });

  it("has no duplicate ids", () => {
    expect(new Set(COMMAND_IDS).size).toBe(COMMAND_IDS.length);
  });
});

describe("command run() bodies call the right ctx method", () => {
  it.each([
    ["tab.new", "newTab"],
    ["tab.close", "closeActiveTab"], // closes the WHOLE tab (finding 4)
    ["pane.close", "closePane"], // closes the focused pane (⌘W)
    ["pane.split-right", "splitRight"],
    ["pane.set-badge", "setBadge"],
    ["terminal.clear-scrollback", "clearScrollback"],
    ["search.open", "openSearch"], // trmx-98
    ["search.next", "searchNext"],
    ["search.prev", "searchPrev"],
    ["search.close", "closeSearch"],
    ["app.settings", "openSettings"],
    ["app.check-updates", "checkForUpdates"],
    ["window.close", "closeWindow"],
    ["app.command-palette", "openCommandPalette"],
  ])("%s → ctx.%s", (id, method) => {
    const ctx = fakeCtx();
    byId(id).run(ctx);
    expect(ctx[method as keyof CommandContext]).toHaveBeenCalledTimes(1);
  });

  it("tab.select-3 selects index 2; pane.focus-left / grow-right pass the direction", () => {
    const ctx = fakeCtx();
    byId("tab.select-3").run(ctx);
    expect(ctx.selectTab).toHaveBeenCalledWith(2);
    byId("pane.focus-left").run(ctx);
    expect(ctx.focusPane).toHaveBeenCalledWith("left");
    byId("pane.grow-right").run(ctx);
    expect(ctx.growPane).toHaveBeenCalledWith("right");
  });

  it("parameterized theme.select / script.run pass the chosen arg", () => {
    const ctx = fakeCtx();
    byId("theme.select").run(ctx, "night");
    expect(ctx.selectTheme).toHaveBeenCalledWith("night");
    byId("script.run").run(ctx, "source '/x/a.sh'");
    expect(ctx.runScript).toHaveBeenCalledWith("source '/x/a.sh'");
    expect(byId("theme.select").param).toBe("theme");
    expect(byId("script.run").param).toBe("script");
  });
});

describe("when guards", () => {
  it("tab.select-1..8 need that many tabs; ⌘9 (select-9) is the iTerm 'last tab' for any nonzero count", () => {
    expect(byId("tab.select-8").when!(fakeCtx({ tabCount: () => 3 }))).toBe(false);
    // tab.select-9 selects the LAST tab, so it is available with any nonzero count (finding 5).
    expect(byId("tab.select-9").when!(fakeCtx({ tabCount: () => 3 }))).toBe(true);
    expect(byId("tab.select-9").when!(fakeCtx({ tabCount: () => 0 }))).toBe(false);
  });

  it("pane nav/close/grow need >1 (or >0) panes", () => {
    expect(byId("pane.next").when!(fakeCtx({ paneCount: () => 1 }))).toBe(false);
    expect(byId("pane.grow-left").when!(fakeCtx({ paneCount: () => 2 }))).toBe(true);
    expect(byId("pane.close").when!(fakeCtx({ paneCount: () => 1 }))).toBe(true);
  });

  it("tab.new / pane.split have no guard (always available)", () => {
    expect(byId("tab.new").when).toBeUndefined();
    expect(byId("pane.split-right").when).toBeUndefined();
  });
});
