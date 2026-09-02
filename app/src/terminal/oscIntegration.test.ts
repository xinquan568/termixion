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
import { currentCwd } from "./osc7";
import { __resetSettingsForTest, makeSettingsStore } from "../store/settingsStore";

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

    // OSC 7 flows through the PRODUCTION composition into the module-default store — assert via
    // currentCwd(), the exact read path later features use (step-8 finding: a second direct
    // attachOsc7 registration would bypass the composition under test). Vitest isolates test
    // files, so the module-default store cannot bleed into other suites.
    await feed(term, "\x1b]7;file://host/Users/prod/dir\x07");
    expect(currentCwd()).toBe("/Users/prod/dir");

    // Teardown: further OSC traffic is inert.
    teardown();
    await feed(term, "\x1b]2;after teardown\x07");
    expect(setTitle).toHaveBeenCalledTimes(1);
  });

  // trmx-252 (test 11, integration half): the unit test pins that attachOsc52 reads its INJECTED
  // policy at write time. This pins that the PRODUCTION composition injects a thunk over the real
  // settings registry — the gap a fake policy cannot see, and the one that would ship a setting
  // that appears to need a restart.
  it("reads terminal.clipboardWrite from the LIVE registry on every write, not at attach time", async () => {
    const term = openProductionLikeTerm();
    const writeClipboard = vi.fn();
    const teardown = realAttachOscIntegrations(term as never, {
      setTitle: vi.fn(),
      writeClipboard,
    });
    try {
      const settings = makeSettingsStore();
      expect(settings.get("terminal.clipboardWrite")).toBe("allow"); // the default

      await feed(term, "\x1b]52;c;aGk=\x07");
      expect(writeClipboard).toHaveBeenCalledTimes(1);

      // Flip the setting on the ALREADY-ATTACHED handler — no remount, no re-attach.
      settings.set("terminal.clipboardWrite", "deny");
      await feed(term, "\x1b]52;c;aGk=\x07");
      expect(writeClipboard).toHaveBeenCalledTimes(1); // denied live

      settings.set("terminal.clipboardWrite", "allow");
      await feed(term, "\x1b]52;c;aGk=\x07");
      expect(writeClipboard).toHaveBeenCalledTimes(2); // and allowed again, live
    } finally {
      teardown();
      __resetSettingsForTest();
    }
  });
});
