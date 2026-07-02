// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53 (test-first): the pre-first-paint theme application. Static CSS cannot know the
// persisted theme, so startup reads it synchronously (materializing the first-run default) and
// paints the body — plus the settings surface's --tx-* vars — before anything renders. The
// ORDERING (module-level in main.tsx, before boot()'s first await) is guarded by
// main.order.test.ts; this spec covers the behavior.
import { describe, expect, it } from "vitest";
import { applyStartupTheme } from "./applyStartupTheme";
import { themes } from "./themes";
import type { KeyValueStore } from "../settings/settingsStore";

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const probe = (color: string) => {
  const el = document.createElement("div");
  el.style.background = color;
  return el.style.background;
};

describe("applyStartupTheme", () => {
  it("paints the terminal surface's body from the persisted theme", () => {
    applyStartupTheme({
      storage: fakeStorage({ "termixion.appearance.theme": "solarized" }),
      doc: document,
      search: "",
    });
    expect(document.body.style.background).toBe(probe(themes.solarized.color.bg.primary));
    // The terminal surface needs no --tx-* vars; the settings surface writes them (below).
  });

  it("materializes the first-run default when nothing is persisted (jsdom → night)", () => {
    const storage = fakeStorage();
    applyStartupTheme({ storage, doc: document, search: "" });
    expect(storage.data.get("termixion.appearance.theme")).toBe("night");
    expect(document.body.style.background).toBe(probe(themes.night.color.bg.primary));
  });

  it("treats junk persisted values as the derived default", () => {
    applyStartupTheme({
      storage: fakeStorage({ "termixion.appearance.theme": "hotdog-stand" }),
      doc: document,
      search: "",
    });
    expect(document.body.style.background).toBe(probe(themes.night.color.bg.primary));
  });

  it("also writes the --tx-* vars for the settings surface", () => {
    applyStartupTheme({
      storage: fakeStorage({ "termixion.appearance.theme": "paper" }),
      doc: document,
      search: "?window=settings&section=appearance",
    });
    expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#EEEDED");
    expect(document.body.style.background).toBe(probe(themes.paper.color.bg.primary));
  });
});
