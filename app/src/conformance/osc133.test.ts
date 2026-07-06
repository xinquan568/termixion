// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-99 (FR-7b): OSC 133 conformance — driven through the PRODUCTION emulation slice (openTerm), so
// these pin Termixion's configured emulator (the trmx-64 invariant), not bare xterm. Two tiers: (1)
// PARSE-SAFETY via the harness's generic observers — a 133 marker is consumed and the surrounding stream
// is intact (OSC 133 has no xterm-visible side effect, like the unknown-OSC pattern in osc.test.ts); (2)
// SEMANTICS by registering the real `attachOsc133` on the production terminal + asserting the sink fired.
import { describe, it, expect, vi } from "vitest";
import { openTerm, feed, line } from "./driver";
import { attachOsc133, type Osc133TerminalLike, type PromptTransition } from "../terminal/osc133";

describe("conformance: OSC 133 parse-safety (production slice)", () => {
  it("a 133 marker is consumed and does not corrupt the surrounding stream", async () => {
    const term = openTerm();
    // BEL-terminated OSC 133;C between visible text; the markers must vanish, the text survive.
    await feed(term, "before\x1b]133;A\x07\x1b]133;C\x07mid\x1b]133;D;0\x07after");
    expect(line(term, 0)).toBe("beforemidafter");
  });

  it("a malformed 133 payload is also consumed (no garbage printed)", async () => {
    const term = openTerm();
    await feed(term, "x\x1b]133;garbage;stuff\x07y");
    expect(line(term, 0)).toBe("xy");
  });
});

describe("conformance: OSC 133 semantics via the real handler on the production terminal", () => {
  it("drives the prompt machine A→C→D through the shipped emulator", async () => {
    const term = openTerm();
    const emit = vi.fn<(t: PromptTransition) => void>();
    const teardown = attachOsc133(term as unknown as Osc133TerminalLike, emit);
    await feed(term, "\x1b]133;A\x07");
    await feed(term, "\x1b]133;C\x07"); // running
    await feed(term, "\x1b]133;D;7\x07"); // finished, exit 7
    const busies = emit.mock.calls.map((c) => c[0].busy);
    expect(busies).toEqual([false, true, false]);
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ busy: false, exitCode: 7 });
    teardown();
  });
});
