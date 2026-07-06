// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-4 (test-first): the WebGL→DOM renderer fallback strategy. Tested with fakes — no real xterm,
// WebGL, or layout — so the *decision logic* is verified deterministically in jsdom. Real rendering
// is exercised by `pnpm dev` and later the packaged `--smoke` (C/D-3), not here.
import { describe, it, expect } from "vitest";
import {
  mountTerminal,
  type AddonLike,
  type FitLike,
  type MountDeps,
  type SearchAddonLike,
  type TerminalLike,
} from "./mountTerminal";

interface FakeTerminal extends TerminalLike {
  opened: HTMLElement | null;
  addons: Array<AddonLike | FitLike | SearchAddonLike>;
  disposed: boolean;
}
function fakeTerminal(): FakeTerminal {
  return {
    opened: null,
    addons: [],
    disposed: false,
    open(container) {
      this.opened = container;
    },
    loadAddon(addon) {
      this.addons.push(addon);
    },
    write() {},
    onData() {},
    onResize() {},
    dispose() {
      this.disposed = true;
    },
  };
}

interface FakeWebgl extends AddonLike {
  lossHandlers: Array<() => void>;
  disposed: boolean;
}
function fakeWebgl(): FakeWebgl {
  return {
    lossHandlers: [],
    disposed: false,
    onContextLoss(handler) {
      this.lossHandlers.push(handler);
    },
    dispose() {
      this.disposed = true;
    },
  };
}

interface FakeFit extends FitLike {
  fitCount: number;
  disposed: boolean;
}
function fakeFit(): FakeFit {
  return {
    fitCount: 0,
    disposed: false,
    fit() {
      this.fitCount += 1;
    },
    dispose() {
      this.disposed = true;
    },
  };
}

// trmx-98: a fake search addon (loadable + narrow surface). Tracks disposal so the mount test can assert
// it is loaded onto the terminal and torn down with the handle.
interface FakeSearch {
  disposed: boolean;
  findNext(term: string): boolean;
  findPrevious(term: string): boolean;
  clearDecorations(): void;
  onDidChangeResults(handler: (e: { resultIndex: number; resultCount: number }) => void): { dispose(): void };
  dispose(): void;
}
function fakeSearch(): FakeSearch {
  return {
    disposed: false,
    findNext: () => false,
    findPrevious: () => false,
    clearDecorations() {},
    onDidChangeResults: () => ({ dispose() {} }),
    dispose() {
      this.disposed = true;
    },
  };
}

// mountTerminal only forwards the container to terminal.open(); the fake stores it, so a bare
// object stands in for a real DOM node and keeps this a pure unit test.
const container = {} as HTMLElement;

describe("mountTerminal", () => {
  it("opens the terminal and uses the WebGL renderer when the addon loads", () => {
    const term = fakeTerminal();
    const webgl = fakeWebgl();
    const deps: MountDeps = {
      createTerminal: () => term,
      createWebglAddon: () => webgl,
      createFitAddon: () => fakeFit(),
      createSearchAddon: () => fakeSearch(),
    };

    const handle = mountTerminal(container, deps);

    expect(term.opened).toBe(container);
    expect(term.addons).toContain(webgl);
    expect(handle.renderer).toBe("webgl");
  });

  it("loads the fit addon and fits the grid to the host on mount", () => {
    const term = fakeTerminal();
    const fit = fakeFit();
    const deps: MountDeps = {
      createTerminal: () => term,
      createWebglAddon: () => fakeWebgl(),
      createFitAddon: () => fit,
      createSearchAddon: () => fakeSearch(),
    };

    const handle = mountTerminal(container, deps);

    // The fit addon is loaded so xterm's grid can track the host element's size...
    expect(term.addons).toContain(fit);
    // ...and the grid is fitted once on mount so the terminal fills its host from the start.
    expect(fit.fitCount).toBe(1);
    expect(handle.fit).toBeTypeOf("function");
  });

  it("loads the search addon and exposes it on handle.search (trmx-98)", () => {
    const term = fakeTerminal();
    const search = fakeSearch();
    const handle = mountTerminal(container, {
      createTerminal: () => term,
      createWebglAddon: () => fakeWebgl(),
      createFitAddon: () => fakeFit(),
      createSearchAddon: () => search,
    });
    expect(term.addons).toContain(search); // loaded onto the terminal (renderer-agnostic, like fit)
    expect(handle.search).toBe(search); // and reachable so App can drive the find bar
    handle.dispose();
    expect(search.disposed).toBe(true); // torn down with the handle
  });

  it("re-fits the grid when handle.fit() is called (resize path)", () => {
    const fit = fakeFit();
    const deps: MountDeps = {
      createTerminal: () => fakeTerminal(),
      createWebglAddon: () => fakeWebgl(),
      createFitAddon: () => fit,
      createSearchAddon: () => fakeSearch(),
    };

    const handle = mountTerminal(container, deps);
    expect(fit.fitCount).toBe(1); // the initial mount fit

    handle.fit();
    handle.fit();

    expect(fit.fitCount).toBe(3); // initial + two explicit re-fits
  });

  it("fits the grid even when WebGL is unavailable (DOM renderer)", () => {
    const fit = fakeFit();
    const deps: MountDeps = {
      createTerminal: () => fakeTerminal(),
      createWebglAddon: () => {
        throw new Error("WebGL2 unavailable");
      },
      createFitAddon: () => fit,
      createSearchAddon: () => fakeSearch(),
    };

    const handle = mountTerminal(container, deps);

    expect(handle.renderer).toBe("dom");
    expect(fit.fitCount).toBe(1); // the fit addon is renderer-agnostic, so it still sizes the grid
  });

  it("falls back to the DOM renderer when the WebGL addon cannot be created", () => {
    const term = fakeTerminal();
    const deps: MountDeps = {
      createTerminal: () => term,
      createWebglAddon: () => {
        throw new Error("WebGL2 unavailable");
      },
      createFitAddon: () => fakeFit(),
      createSearchAddon: () => fakeSearch(),
    };

    const handle = mountTerminal(container, deps);

    expect(term.opened).toBe(container); // the terminal still renders (DOM renderer)
    expect(handle.renderer).toBe("dom");
  });

  it("falls back to DOM and disposes the half-registered addon when activation fails", () => {
    const term = fakeTerminal();
    term.loadAddon = (addon) => {
      // Only the WebGL addon's activation fails; the fit addon must still load.
      if ((addon as AddonLike).onContextLoss) {
        throw new Error("addon activation failed");
      }
    };
    const webgl = fakeWebgl();
    const deps: MountDeps = {
      createTerminal: () => term,
      createWebglAddon: () => webgl,
      createFitAddon: () => fakeFit(),
      createSearchAddon: () => fakeSearch(),
    };

    const handle = mountTerminal(container, deps);

    expect(handle.renderer).toBe("dom");
    // The addon was created (and xterm may have registered it) before activation threw, so it must
    // be torn down rather than left attached to the terminal.
    expect(webgl.disposed).toBe(true);
  });

  it("disposes the WebGL addon and reverts to DOM on context loss", () => {
    const term = fakeTerminal();
    const webgl = fakeWebgl();
    const deps: MountDeps = {
      createTerminal: () => term,
      createWebglAddon: () => webgl,
      createFitAddon: () => fakeFit(),
      createSearchAddon: () => fakeSearch(),
    };

    const handle = mountTerminal(container, deps);
    expect(handle.renderer).toBe("webgl");
    expect(webgl.lossHandlers).toHaveLength(1);

    // Simulate the WebGL context being lost — the "forcing fallback still renders" path.
    webgl.lossHandlers[0]();

    expect(webgl.disposed).toBe(true);
    expect(handle.renderer).toBe("dom");
  });

  it("dispose() tears down the fit addon, the WebGL addon, and the terminal", () => {
    const term = fakeTerminal();
    const webgl = fakeWebgl();
    const fit = fakeFit();

    const handle = mountTerminal(container, {
      createTerminal: () => term,
      createWebglAddon: () => webgl,
      createFitAddon: () => fit,
      createSearchAddon: () => fakeSearch(),
    });
    handle.dispose();

    expect(fit.disposed).toBe(true);
    expect(webgl.disposed).toBe(true);
    expect(term.disposed).toBe(true);
  });
});
