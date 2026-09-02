// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-252, review finding 3: the runtime probe (`cspProbe.ts`) verifies the policy is ENFORCED and
// COMPATIBLE — it cannot verify the policy is STRONG. A wide-open `script-src * 'unsafe-inline'
// 'unsafe-eval'` would satisfy every runtime check, because every positive probe would still pass
// and the img-src canary would still be blocked.
//
// This is the strength half: it pins the directives in tauri.conf.json by source, so widening one
// is a deliberate, reviewed edit rather than something that silently slips past a green smoke.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// `resolve(process.cwd(), …)` is this repo's convention for reading source files from a test
// (fontChokepoint.test.ts:24, TabStrip.test.tsx:873): vitest runs with cwd = app/, and jsdom leaves
// `import.meta.url` as a non-file URL.
const CONF = resolve(process.cwd(), "../crates/termixion-tauri/tauri.conf.json");

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...sources] = part.split(/\s+/);
        return [name, sources] as const;
      }),
  );
}

const security = JSON.parse(readFileSync(CONF, "utf8")).app.security as {
  csp: string;
  devCsp: string;
};

describe("the shipped Content-Security-Policy", () => {
  const csp = directives(security.csp);

  it("declares every directive the app relies on — a missing one falls back to default-src silently", () => {
    expect([...csp.keys()].sort()).toEqual(
      [
        "connect-src",
        "default-src",
        "font-src",
        "img-src",
        "script-src",
        "style-src",
        "worker-src",
      ].sort(),
    );
  });

  // The only network origins this app may name. `http://ipc.localhost` is Tauri's own IPC endpoint
  // and `ws://localhost:5173` is Vite's HMR socket (devCsp only) — everything else is off-machine.
  const LOCAL_ORIGINS = new Set(["http://ipc.localhost", "ws://localhost:5173"]);

  it("never admits a wildcard, 'unsafe-eval', or an OFF-MACHINE origin", () => {
    for (const [name, sources] of csp) {
      for (const source of sources) {
        expect(source, `${name} must not be a wildcard`).not.toBe("*");
        expect(source, `${name} must not allow eval`).not.toBe("'unsafe-eval'");
        if (/^(https?|wss?):\/\//.test(source)) {
          expect(LOCAL_ORIGINS.has(source), `${name} names off-machine origin ${source}`).toBe(true);
        }
      }
    }
  });

  it("pins script-src to 'self' only — the directive that turns an injection into RCE", () => {
    expect(csp.get("script-src")).toEqual(["'self'"]);
  });

  it("allows inline STYLE but not inline SCRIPT", () => {
    // Vite's style handling requires 'unsafe-inline' for style-src (grill assumption A5, confirmed
    // by the packaged probe). script-src must not follow it.
    expect(csp.get("style-src")).toContain("'unsafe-inline'");
    expect(csp.get("script-src")).not.toContain("'unsafe-inline'");
  });

  it("keeps worker-src at 'self' — no app code constructs a blob: worker", () => {
    // Review finding 2: @xterm/addon-webgl 0.18.0 contains no Worker/Blob/createObjectURL, and
    // nothing in app/src does either, so `blob:` was a relaxation with no consumer. The probe now
    // asserts a blob: worker is REFUSED, which is only meaningful while this stays 'self'.
    expect(csp.get("worker-src")).toEqual(["'self'"]);
  });

  it("restricts connect-src to the Tauri IPC origins", () => {
    expect(csp.get("connect-src")).toEqual(["ipc:", "http://ipc.localhost"]);
  });
});

describe("devCsp", () => {
  it("differs from the production policy only by the Vite HMR socket", () => {
    const dev = directives(security.devCsp);
    const prod = directives(security.csp);
    for (const [name, sources] of dev) {
      if (name === "connect-src") {
        expect(sources).toEqual([...(prod.get(name) ?? []), "ws://localhost:5173"]);
      } else {
        expect(sources, `${name} must match production`).toEqual(prod.get(name));
      }
    }
  });

  it("is documented as INERT on desktop, so no gate may claim it", () => {
    // tauri-2.11.5/src/manager/webview.rs:43 — PROXY_DEV_SERVER = cfg!(all(dev, mobile)). On
    // desktop the webview loads the external devUrl directly, so Tauri never injects this policy.
    // The key is kept because it is correct if ever applied; docs/security.md carries the caveat
    // because tauri.conf.json is JSON and cannot hold a comment. This test exists so that deleting
    // the documentation is a failing test rather than a silent loss.
    const docs = readFileSync(resolve(process.cwd(), "../docs/security.md"), "utf8");
    expect(docs).toContain("PROXY_DEV_SERVER");
    expect(docs).toMatch(/devCsp.*(does not apply|no effect|inert)/is);
  });
});
