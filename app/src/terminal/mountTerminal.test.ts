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
  type MountDeps,
  type TerminalLike,
} from "./mountTerminal";

interface FakeTerminal extends TerminalLike {
  opened: HTMLElement | null;
  addons: AddonLike[];
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
    };

    const handle = mountTerminal(container, deps);

    expect(term.opened).toBe(container);
    expect(term.addons).toContain(webgl);
    expect(handle.renderer).toBe("webgl");
  });

  it("falls back to the DOM renderer when the WebGL addon cannot be created", () => {
    const term = fakeTerminal();
    const deps: MountDeps = {
      createTerminal: () => term,
      createWebglAddon: () => {
        throw new Error("WebGL2 unavailable");
      },
    };

    const handle = mountTerminal(container, deps);

    expect(term.opened).toBe(container); // the terminal still renders (DOM renderer)
    expect(handle.renderer).toBe("dom");
  });

  it("falls back to DOM and disposes the half-registered addon when activation fails", () => {
    const term = fakeTerminal();
    term.loadAddon = () => {
      throw new Error("addon activation failed");
    };
    const webgl = fakeWebgl();
    const deps: MountDeps = {
      createTerminal: () => term,
      createWebglAddon: () => webgl,
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
    };

    const handle = mountTerminal(container, deps);
    expect(handle.renderer).toBe("webgl");
    expect(webgl.lossHandlers).toHaveLength(1);

    // Simulate the WebGL context being lost — the "forcing fallback still renders" path.
    webgl.lossHandlers[0]();

    expect(webgl.disposed).toBe(true);
    expect(handle.renderer).toBe("dom");
  });

  it("dispose() tears down both the addon and the terminal", () => {
    const term = fakeTerminal();
    const webgl = fakeWebgl();

    const handle = mountTerminal(container, {
      createTerminal: () => term,
      createWebglAddon: () => webgl,
    });
    handle.dispose();

    expect(webgl.disposed).toBe(true);
    expect(term.disposed).toBe(true);
  });
});
