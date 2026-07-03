// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 round-2 regression: the OSC integrations must work on a terminal built from the BARE
// production option slice. Round 1 shipped module tests that constructed their own flag-enabled
// terminals and TerminalView tests that injected fakes — so nothing caught that production omitted
// `allowProposedApi: true` while `realAttachOscIntegrations` dereferences `terminal.parser` (a
// proposed API whose accessor throws without the flag; the packaged app crashed at mount). This
// test reproduces that gap: a REAL emulator constructed from `emulationTerminalOptions()` with NO
// test-added options (adding a flag here would re-create the blind spot), wired through the same
// composition production uses.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Terminal } from "@xterm/headless";
import { emulationTerminalOptions } from "./emulationOptions";
import { realAttachOscIntegrations } from "./TerminalView";
import { makeCwdStore } from "./osc7";
import { attachOsc7 } from "./osc7";

function feed(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe("OSC integrations over the bare production slice (trmx-64 round-2 regression)", () => {
  const terms: Terminal[] = [];
  afterEach(() => {
    while (terms.length) terms.pop()?.dispose();
  });

  function openProductionLikeTerm(): Terminal {
    // EXACTLY the production emulation options — no allowProposedApi added by the test.
    const term = new Terminal({ ...emulationTerminalOptions() });
    terms.push(term);
    return term;
  }

  it("realAttachOscIntegrations does not throw on a slice-built terminal", () => {
    const term = openProductionLikeTerm();
    expect(() =>
      realAttachOscIntegrations(term as never, {
        setTitle: vi.fn(),
        writeClipboard: vi.fn(),
      }),
    ).not.toThrow();
  });

  it("title, OSC 52 write, and OSC 7 cwd all function end-to-end on the slice-built terminal", async () => {
    const term = openProductionLikeTerm();
    const setTitle = vi.fn();
    const writeClipboard = vi.fn();
    const teardown = realAttachOscIntegrations(term as never, {
      setTitle,
      writeClipboard,
    });

    await feed(term, "\x1b]2;prod title\x07");
    expect(setTitle).toHaveBeenCalledWith("prod title");

    await feed(term, "\x1b]52;c;aGk=\x07"); // base64 "hi"
    expect(writeClipboard).toHaveBeenCalledWith("hi");

    // OSC 7 goes to the module-default store via the production composition; assert with a
    // dedicated store on a second registration to keep this test hermetic.
    const store = makeCwdStore();
    const detach7 = attachOsc7(term as never, store);
    await feed(term, "\x1b]7;file://host/Users/prod/dir\x07");
    expect(store.get()).toBe("/Users/prod/dir");
    detach7();

    // Teardown: further OSC traffic is inert.
    teardown();
    await feed(term, "\x1b]2;after teardown\x07");
    expect(setTitle).toHaveBeenCalledTimes(1);
  });
});
