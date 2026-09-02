// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-252: the probe's own coverage. The properties that make this a gate rather than decoration:
// an empty violation list must NOT be enough to pass (the canaries prove the collector was live),
// each style check must be able to fail INDEPENDENTLY of the other (review finding 4 — sharing an
// id and a sentinel made the inline check tautological), and a failed WebSocket must only be blamed
// on CSP when a violation for THAT socket was recorded (finding 6).
import { describe, expect, it, vi } from "vitest";
import {
  CANARY_URI,
  WS_URI,
  describeCspProbe,
  measureStyle,
  runCspProbe,
  type CspProbeDeps,
  type CspViolation,
} from "./cspProbe";

const imageCanary: CspViolation = {
  effectiveDirective: "img-src",
  blockedURI: CANARY_URI,
  sourceFile: "",
};
const blobCanary: CspViolation = {
  effectiveDirective: "worker-src",
  blockedURI: "blob",
  sourceFile: "",
};
const bothCanaries = [imageCanary, blobCanary];

function deps(over: Partial<CspProbeDeps> = {}): CspProbeDeps {
  return {
    violations: () => bothCanaries,
    collectorPresent: () => true,
    probeLinkStylesheet: () => Promise.resolve("3px"),
    probeInlineStyle: () => Promise.resolve("7px"),
    probeSelfWorker: () => Promise.resolve("csp-probe-echo"),
    probeBlobWorker: () => Promise.resolve(),
    probeWebSocket: () => Promise.resolve(true),
    probeCanary: () => Promise.resolve(),
    detectRenderer: () => "webgl",
    settle: () => Promise.resolve(),
    ...over,
  };
}

describe("runCspProbe", () => {
  it("passes when every check holds, both canaries fired, and nothing else was blocked", async () => {
    const record = await runCspProbe(deps());
    expect(record.ok).toBe(true);
    expect(record.canaries).toEqual({ image: true, blobWorker: true });
    expect(record.violations.unexpected).toEqual([]);
  });

  it("FAILS when a canary never fired — an empty list alone does not prove the collector was live", async () => {
    const none = await runCspProbe(deps({ violations: () => [] }));
    expect(none.ok).toBe(false);
    expect(none.violations.unexpected).toEqual([]); // nothing was "wrong", and it still must not pass

    const imageOnly = await runCspProbe(deps({ violations: () => [imageCanary] }));
    expect(imageOnly.canaries).toEqual({ image: true, blobWorker: false });
    expect(imageOnly.ok).toBe(false);
  });

  it("FAILS when a blob: worker is ALLOWED — worker-src 'self' must refuse it", async () => {
    // The inverted canary (finding 2): nothing in the app needs blob workers, so one starting is
    // itself the regression. A policy that re-adds blob: makes this canary vanish.
    const record = await runCspProbe(deps({ violations: () => [imageCanary] }));
    expect(record.canaries.blobWorker).toBe(false);
    expect(describeCspProbe(record)).toContain("blob:MISSING");
  });

  it("distinguishes an ABSENT collector from a policy that let a canary through", async () => {
    const absent = await runCspProbe(deps({ collectorPresent: () => false, violations: () => [] }));
    expect(absent.collectorPresent).toBe(false);
    expect(describeCspProbe(absent)).toContain("collector=ABSENT");

    const live = await runCspProbe(deps({ violations: () => [] }));
    expect(live.collectorPresent).toBe(true);
    expect(describeCspProbe(live)).toContain("collector=present");
  });

  it("fails when anything outside the canaries was blocked", async () => {
    const blocked: CspViolation = {
      effectiveDirective: "connect-src",
      blockedURI: "https://telemetry.example",
      sourceFile: "index.js",
    };
    const record = await runCspProbe(deps({ violations: () => [...bothCanaries, blocked] }));
    expect(record.ok).toBe(false);
    expect(record.violations.unexpected).toEqual([blocked]);
  });

  it("the two style checks fail INDEPENDENTLY", async () => {
    // Finding 4: previously both used one id and one sentinel and the <link> stayed mounted, so a
    // blocked inline style still measured 3px off the external stylesheet and reported pass.
    const inlineBlocked = await runCspProbe(deps({ probeInlineStyle: () => Promise.resolve("0px") }));
    expect(inlineBlocked.checks.styleInline).toBe("fail");
    expect(inlineBlocked.checks.styleLink).toBe("pass");
    expect(inlineBlocked.ok).toBe(false);

    const linkBlocked = await runCspProbe(deps({ probeLinkStylesheet: () => Promise.reject(new Error("blocked")) }));
    expect(linkBlocked.checks.styleLink).toBe("fail");
    expect(linkBlocked.checks.styleInline).toBe("pass");
    expect(linkBlocked.ok).toBe(false);
  });

  it("does not accept the OTHER check's sentinel — the values are not interchangeable", async () => {
    // If the inline check ever measured the link stylesheet's 3px, this would pass. It must not.
    const crossed = await runCspProbe(deps({ probeInlineStyle: () => Promise.resolve("3px") }));
    expect(crossed.checks.styleInline).toBe("fail");
  });

  it("blames CSP for a failed socket only when THAT socket's violation was recorded", async () => {
    const socketBlocked: CspViolation = {
      effectiveDirective: "connect-src",
      blockedURI: `${WS_URI}/`,
      sourceFile: "",
    };
    const record = await runCspProbe(
      deps({
        probeWebSocket: () => Promise.resolve(false),
        violations: () => [...bothCanaries, socketBlocked],
      }),
    );
    expect(record.checks.webSocket).toBe("csp-fail");
  });

  it("does NOT blame CSP when an unrelated connect-src violation is present (finding 6)", async () => {
    const unrelated: CspViolation = {
      effectiveDirective: "connect-src",
      blockedURI: "https://elsewhere.example/api",
      sourceFile: "",
    };
    const record = await runCspProbe(
      deps({
        probeWebSocket: () => Promise.resolve(false),
        violations: () => [...bothCanaries, unrelated],
      }),
    );
    // Correlated by blocked URI, not merely by directive name.
    expect(record.checks.webSocket).toBe("inconclusive");
  });

  it.each([
    ["a port that merely shares the prefix", "ws://localhost:51730/"],
    ["a different path on the same port", "ws://localhost:5173/other"],
  ])("does NOT attribute %s to the probe socket", async (_label, blockedURI) => {
    // The first version compared with startsWith, which matched both of these.
    const record = await runCspProbe(
      deps({
        probeWebSocket: () => Promise.resolve(false),
        violations: () => [
          ...bothCanaries,
          { effectiveDirective: "connect-src", blockedURI, sourceFile: "" },
        ],
      }),
    );
    expect(record.checks.webSocket).toBe("inconclusive");
  });

  it("reports a failed socket with no violation as inconclusive, not as a CSP failure", async () => {
    const record = await runCspProbe(deps({ probeWebSocket: () => Promise.resolve(false) }));
    // Vite 8 rejects a handshake without the vite-hmr subprotocol/token, so a bare failure here is
    // environmental. Still a non-pass, but never reported as a CSP verdict.
    expect(record.checks.webSocket).toBe("inconclusive");
    expect(record.ok).toBe(false);
  });

  it("skips the socket check outside dev without failing on it", async () => {
    const record = await runCspProbe(deps({ probeWebSocket: null }));
    expect(record.checks.webSocket).toBe("skipped");
    expect(record.ok).toBe(true);
  });

  it("records the renderer without letting it decide the verdict", async () => {
    const fallback = await runCspProbe(deps({ detectRenderer: () => "dom-fallback" }));
    expect(fallback.renderer).toBe("dom-fallback");
    expect(fallback.ok).toBe(true); // a headless runner without WebGL2 is not a CSP failure

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

  it("treats a thrown positive check as a failure rather than propagating", async () => {
    const record = await runCspProbe(deps({ probeSelfWorker: () => Promise.reject(new Error("blocked")) }));
    expect(record.checks.workerSelf).toBe("fail");
    expect(record.ok).toBe(false);
  });

  it("swallows a throwing negative probe — a rejection is the expected shape of a block", async () => {
    const record = await runCspProbe(
      deps({ probeBlobWorker: () => Promise.reject(new Error("refused")) }),
    );
    expect(record.ok).toBe(true); // the violation list, not the promise, is the evidence
  });
});

describe("describeCspProbe", () => {
  it("names every failing check and every unexpected violation", async () => {
    const blocked: CspViolation = {
      effectiveDirective: "font-src",
      blockedURI: "https://fonts.example/x.woff2",
      sourceFile: "",
    };
    const record = await runCspProbe(
      deps({
        probeSelfWorker: () => Promise.resolve("wrong"),
        violations: () => [...bothCanaries, blocked],
      }),
    );
    const text = describeCspProbe(record);
    expect(text).toContain("csp=FAIL");
    expect(text).toContain("workerSelf=fail");
    expect(text).toContain("violation[font-src https://fonts.example/x.woff2]");
    expect(text).toContain("canaries=img:seen,blob:seen");
  });

  it("names which canary is missing", async () => {
    const record = await runCspProbe(deps({ violations: () => [blobCanary] }));
    expect(describeCspProbe(record)).toContain("canaries=img:MISSING,blob:seen");
  });
});

// Review finding 4, second half: the correctness bug was fixed by distinct ids/sentinels, but the
// CLEANUP that makes the checks repeatable had no coverage. These run against jsdom's real DOM.
describe("measureStyle cleanup", () => {
  it("removes BOTH the target element and the injected node", async () => {
    const style = document.createElement("style");
    style.textContent = "#cleanup-probe { padding-top: 7px; }";
    await measureStyle("cleanup-probe", style, false);
    expect(document.getElementById("cleanup-probe")).toBeNull();
    expect(document.head.contains(style)).toBe(false);
  });

  it("removes both even when the injected node fails to load", async () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/does-not-exist.css";
    const failing = measureStyle("cleanup-probe-2", link, true);
    // jsdom does not fetch, so drive the failure the way a blocked stylesheet would.
    link.onerror?.(new Event("error"));
    await expect(failing).rejects.toThrow();
    expect(document.getElementById("cleanup-probe-2")).toBeNull();
    expect(document.head.contains(link)).toBe(false);
  });

  it("leaves the document as it found it across repeated runs", async () => {
    const before = document.head.childElementCount;
    for (let i = 0; i < 3; i += 1) {
      const style = document.createElement("style");
      style.textContent = "#repeat-probe { padding-top: 7px; }";
      await measureStyle("repeat-probe", style, false);
    }
    expect(document.head.childElementCount).toBe(before);
    expect(document.querySelectorAll("#repeat-probe")).toHaveLength(0);
  });
});
