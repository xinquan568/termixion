// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-252: the probe's own coverage. The point of these tests is the two properties that make the
// gate meaningful rather than decorative: an empty `unexpected` list must NOT be enough to pass
// (the canary proves the collector was live), and a failed WebSocket must only be blamed on CSP
// when a matching violation was actually recorded.
import { describe, expect, it, vi } from "vitest";
import {
  CANARY_URI,
  describeCspProbe,
  runCspProbe,
  type CspProbeDeps,
  type CspViolation,
} from "./cspProbe";

const canary: CspViolation = {
  effectiveDirective: "img-src",
  blockedURI: CANARY_URI,
  sourceFile: "",
};

function deps(over: Partial<CspProbeDeps> = {}): CspProbeDeps {
  return {
    violations: () => [canary],
    probeLinkStylesheet: () => Promise.resolve("3px"),
    probeInlineStyle: () => Promise.resolve("3px"),
    probeSelfWorker: () => Promise.resolve("csp-probe-echo"),
    probeBlobWorker: () => Promise.resolve("csp-probe-echo"),
    probeWebSocket: () => Promise.resolve(true),
    probeCanary: () => Promise.resolve(),
    detectRenderer: () => "webgl",
    settle: () => Promise.resolve(),
    ...over,
  };
}

describe("runCspProbe", () => {
  it("passes when every check holds, the canary fired, and nothing else was blocked", async () => {
    const record = await runCspProbe(deps());
    expect(record.ok).toBe(true);
    expect(record.violations.expected).toEqual([canary]);
    expect(record.violations.unexpected).toEqual([]);
  });

  it("FAILS when the canary never fired — an empty list alone does not prove the collector was live", async () => {
    const record = await runCspProbe(deps({ violations: () => [] }));
    expect(record.ok).toBe(false);
    expect(record.violations.expected).toEqual([]);
    // The distinction that matters: nothing was "wrong", yet the gate must not pass.
    expect(record.violations.unexpected).toEqual([]);
  });

  it("fails when anything other than the canary was blocked", async () => {
    const blocked: CspViolation = {
      effectiveDirective: "worker-src",
      blockedURI: "blob",
      sourceFile: "index.js",
    };
    const record = await runCspProbe(deps({ violations: () => [canary, blocked] }));
    expect(record.ok).toBe(false);
    expect(record.violations.unexpected).toEqual([blocked]);
  });

  it("blames CSP for a failed socket ONLY when a connect-src violation was recorded", async () => {
    const connectBlocked: CspViolation = {
      effectiveDirective: "connect-src",
      blockedURI: "ws://localhost:5173/",
      sourceFile: "",
    };
    const record = await runCspProbe(
      deps({
        probeWebSocket: () => Promise.resolve(false),
        violations: () => [canary, connectBlocked],
      }),
    );
    expect(record.checks.webSocket).toBe("csp-fail");
    expect(record.ok).toBe(false);
  });

  it("reports a failed socket with no violation as inconclusive, not as a CSP failure", async () => {
    const record = await runCspProbe(deps({ probeWebSocket: () => Promise.resolve(false) }));
    // Vite 8 rejects a handshake without the vite-hmr subprotocol/token, so a bare failure here is
    // environmental. It is still a non-pass, but it must never be reported as a CSP verdict.
    expect(record.checks.webSocket).toBe("inconclusive");
    expect(record.ok).toBe(false);
  });

  it("skips the socket check under the packaged gate without failing", async () => {
    const record = await runCspProbe(deps({ probeWebSocket: null, probeInlineStyle: () => Promise.reject(new Error("no dev")) }));
    expect(record.checks.webSocket).toBe("skipped");
    expect(record.checks.styleInline).toBe("fail");
    expect(record.ok).toBe(false);
  });

  it("records the renderer without letting it decide the verdict", async () => {
    const fallback = await runCspProbe(deps({ detectRenderer: () => "dom-fallback" }));
    expect(fallback.renderer).toBe("dom-fallback");
    // A headless runner without WebGL2 is not a CSP failure.
    expect(fallback.ok).toBe(true);

    const errored = await runCspProbe(
      deps({
        detectRenderer: () => {
          throw new Error("no canvas");
        },
      }),
    );
    expect(errored.renderer).toBe("error");
    expect(errored.ok).toBe(true);
  });

  it("lets queued violation events settle before forming a verdict", async () => {
    const settle = vi.fn(() => Promise.resolve());
    await runCspProbe(deps({ settle }));
    expect(settle).toHaveBeenCalledOnce();
  });

  it("treats a thrown check as a failure rather than propagating", async () => {
    const record = await runCspProbe(deps({ probeSelfWorker: () => Promise.reject(new Error("blocked")) }));
    expect(record.checks.workerSelf).toBe("fail");
    expect(record.ok).toBe(false);
  });
});

describe("describeCspProbe", () => {
  it("names every failing check and every unexpected violation in the smoke reason", async () => {
    const blocked: CspViolation = {
      effectiveDirective: "worker-src",
      blockedURI: "blob",
      sourceFile: "",
    };
    const record = await runCspProbe(
      deps({
        probeBlobWorker: () => Promise.resolve("wrong"),
        violations: () => [canary, blocked],
      }),
    );
    const text = describeCspProbe(record);
    expect(text).toContain("csp=FAIL");
    expect(text).toContain("workerBlob=fail");
    expect(text).toContain("violation[worker-src blob]");
    expect(text).toContain("canary=seen");
  });

  it("says the canary is MISSING when the collector recorded nothing", async () => {
    const record = await runCspProbe(deps({ violations: () => [] }));
    expect(describeCspProbe(record)).toContain("canary=MISSING");
  });
});
