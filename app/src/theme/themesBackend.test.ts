// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (FR-6, test-first): the frontend themes service. The real invoke/event edges need the
// Tauri runtime; here every seam is exercised with a fake InvokeFn / EventBus. readUserThemes coerces
// junk to [] and drops malformed entries; hydrateUserThemes pushes the read set into the runtime
// registry (asserted through listThemes / isRegisteredThemeId) and no-ops when there is no runtime;
// writeUserTheme / openThemesDir pin the command + args; onThemesChanged mirrors onPtyExited's
// live-guard / teardown-safe-before-listen-resolves / no-runtime discipline, firing on the bare signal.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEMES_CHANGED_EVENT,
  hydrateUserThemes,
  onThemesChanged,
  openThemesDir,
  readUserThemes,
  writeUserTheme,
} from "./themesBackend";
import {
  clearUserThemes,
  isRegisteredThemeId,
  listThemes,
  type UserThemeEntry,
} from "./registry";
import type { ThemeSpec } from "./themeDerive";
import type { AnsiPalette } from "./tokens";
import type { InvokeFn } from "../ipc/backend";
import type { EventBus } from "../ipc/eventBus";

/** A neutral 16-color palette (mirrors registry.test.ts's fixture). */
const ANSI: AnsiPalette = {
  black: "#000000", red: "#ff0000", green: "#00ff00", yellow: "#ffff00",
  blue: "#0000ff", magenta: "#ff00ff", cyan: "#00ffff", white: "#ffffff",
  brightBlack: "#808080", brightRed: "#ff8080", brightGreen: "#80ff80", brightYellow: "#ffff80",
  brightBlue: "#8080ff", brightMagenta: "#ff80ff", brightCyan: "#80ffff", brightWhite: "#f0f6fc",
};

/** A required-set-only ThemeSpec (black bg / white text → high contrast, no warnings). */
function validSpec(): ThemeSpec {
  return {
    isDark: true,
    color: { bg: { primary: "#000000" }, text: { primary: "#ffffff" }, accent: {}, semantic: {} },
    terminal: { ansi: { ...ANSI }, scrollbar: {}, pane: {} },
  };
}

/** A well-shaped, valid user entry as themes_read() delivers it. */
function validEntry(id: string): UserThemeEntry {
  return { id, source: "user", valid: true, spec: validSpec(), warnings: [] };
}

// The registry is module-level — reset it before each test so registration is observed in isolation.
beforeEach(() => {
  clearUserThemes();
});

describe("readUserThemes", () => {
  it("invokes themes_read and returns the well-shaped entries", async () => {
    const entries = [validEntry("user:a"), validEntry("user:b")];
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(entries);
    await expect(readUserThemes(invoke)).resolves.toEqual(entries);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("themes_read");
  });

  it.each([undefined, null, "nope", 7, {}, { entries: [] }, true])(
    "coerces a non-array result to [] (%j)",
    async (junk) => {
      const invoke = vi.fn<InvokeFn>();
      invoke.mockResolvedValue(junk);
      await expect(readUserThemes(invoke)).resolves.toEqual([]);
    },
  );

  it("drops malformed entries — an entry needs a string id AND a boolean valid", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue([
      validEntry("user:ok"),
      null,
      "a string",
      42,
      {},
      { id: 7, valid: true }, // non-string id
      { id: "user:x" }, // missing valid
      { id: "user:y", valid: "yes" }, // non-boolean valid
      { valid: false }, // missing id
      // a shape-valid but semantically-invalid entry is KEPT — the registry surfaces its warnings.
      { id: "user:broken", source: "user", valid: false, spec: null, warnings: [] },
    ]);
    const result = await readUserThemes(invoke);
    expect(result.map((e) => e.id)).toEqual(["user:ok", "user:broken"]);
  });

  it("propagates a rejected invoke (hydrate, not this seam, owns the no-runtime catch)", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockRejectedValue(new Error("no Tauri runtime"));
    await expect(readUserThemes(invoke)).rejects.toThrow("no Tauri runtime");
  });
});

describe("hydrateUserThemes", () => {
  it("reads then registers the user set — listThemes + the guards reflect it", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue([validEntry("user:a"), validEntry("user:b")]);

    const returned = await hydrateUserThemes(invoke);
    expect(returned.map((e) => e.id)).toEqual(["user:a", "user:b"]);

    // Observe the registry through its own surface (no private spy needed).
    expect(isRegisteredThemeId("user:a")).toBe(true);
    expect(isRegisteredThemeId("user:b")).toBe(true);
    expect(listThemes().filter((e) => e.source === "user").map((e) => e.id)).toEqual([
      "user:a",
      "user:b",
    ]);
  });

  it("REPLACES the registered set on each call (registerUserThemes semantics)", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValueOnce([validEntry("user:first")]);
    await hydrateUserThemes(invoke);
    invoke.mockResolvedValueOnce([validEntry("user:second")]);
    await hydrateUserThemes(invoke);
    expect(listThemes().filter((e) => e.source === "user").map((e) => e.id)).toEqual(["user:second"]);
  });

  it("no-ops on rejection (no Tauri runtime): registers nothing and resolves []", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockRejectedValue(new Error("no Tauri runtime"));

    await expect(hydrateUserThemes(invoke)).resolves.toEqual([]);
    expect(listThemes().some((e) => e.source === "user")).toBe(false);
  });
});

describe("writeUserTheme", () => {
  it("invokes themes_write with { stem, text } and returns the backend string", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue("user:mytheme");
    await expect(writeUserTheme("mytheme", "is_dark = true\n", invoke)).resolves.toBe("user:mytheme");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("themes_write", {
      stem: "mytheme",
      text: "is_dark = true\n",
    });
  });

  it("propagates a rejected invoke (the caller surfaces the write error)", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockRejectedValue(new Error("EACCES"));
    await expect(writeUserTheme("x", "y", invoke)).rejects.toThrow("EACCES");
  });
});

describe("openThemesDir", () => {
  it("invokes themes_open_dir and resolves void", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    await expect(openThemesDir(invoke)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("themes_open_dir");
  });

  it("discards any backend return value (resolves void even for a non-void result)", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue("/some/path");
    await expect(openThemesDir(invoke)).resolves.toBeUndefined();
  });
});

// Same discipline as onPtyExited, minus payload guarding: `themes:changed` is a BARE signal (null
// payload), so the handler fires on every event regardless of what rides along.
describe("onThemesChanged", () => {
  /** A synchronous in-memory bus: listen registers immediately, unlisten removes. */
  function fakeBus() {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const bus: EventBus = {
      emit(event, payload) {
        handlers.get(event)?.forEach((h) => h(payload));
      },
      listen(event, handler) {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
        return Promise.resolve(() => set.delete(handler));
      },
    };
    return { bus, fire: (payload?: unknown) => bus.emit(THEMES_CHANGED_EVENT, payload) };
  }

  it("fires the handler on every event — the null / junk payload is ignored (bare signal)", async () => {
    const { bus, fire } = fakeBus();
    const handler = vi.fn<() => void>();
    onThemesChanged(handler, bus);
    await Promise.resolve(); // let the listen promise settle

    fire(null); // the real backend sends a null payload
    fire(undefined);
    fire({ anything: 1 }); // even junk still fires — the signal matters, not its data
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("teardown unsubscribes — later signals no longer fire", async () => {
    const { bus, fire } = fakeBus();
    const handler = vi.fn<() => void>();
    const teardown = onThemesChanged(handler, bus);
    await Promise.resolve();

    fire();
    expect(handler).toHaveBeenCalledTimes(1);
    teardown();
    fire();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a teardown that runs BEFORE listen resolves still unlistens (no leaked subscription)", async () => {
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    const unlisten = vi.fn();
    const bus: EventBus = {
      emit() {},
      listen: () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        }),
    };

    const teardown = onThemesChanged(() => {}, bus);
    teardown(); // the subscriber is gone before the async listen ever resolved
    resolveListen?.(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("fires nothing after teardown even if the bus still emits (live-guard)", async () => {
    // A bus whose unlisten is a no-op — the `live` guard alone must keep the handler silent.
    const registered: Array<(payload: unknown) => void> = [];
    const bus: EventBus = {
      emit(_event, payload) {
        registered.forEach((h) => h(payload));
      },
      listen(_event, handler) {
        registered.push(handler);
        return Promise.resolve(() => {});
      },
    };
    const handler = vi.fn<() => void>();
    const teardown = onThemesChanged(handler, bus);
    await Promise.resolve();

    teardown();
    bus.emit(THEMES_CHANGED_EVENT, null);
    expect(handler).not.toHaveBeenCalled();
  });

  it("swallows a bus without a runtime (listen rejects) and the teardown stays safe", async () => {
    const bus: EventBus = {
      emit() {},
      listen: () => Promise.reject(new Error("no Tauri runtime")),
    };
    const teardown = onThemesChanged(() => {}, bus);
    await Promise.resolve();
    expect(() => teardown()).not.toThrow();
  });
});
