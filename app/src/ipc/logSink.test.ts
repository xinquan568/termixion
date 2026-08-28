// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-236: the webview diagnostic sink — console + best-effort forwarding, never throws.
import { describe, expect, it, vi } from "vitest";
import { formatDetail, formatRecord, makeLogSink, type LogInvoke } from "./logSink";

function harness(invoke: LogInvoke) {
  const con = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  return { con, sink: makeLogSink(invoke, con) };
}

describe("logSink formatting", () => {
  it("renders an Error's message, a string as-is, and other values as JSON", () => {
    expect(formatDetail(new Error("boom"))).toBe("boom");
    expect(formatDetail("plain")).toBe("plain");
    expect(formatDetail({ key: "font.size", value: 12 })).toBe('{"key":"font.size","value":12}');
    expect(formatDetail(undefined)).toBe("");
  });
  it("prefixes every record with [termixion] and the context", () => {
    expect(formatRecord("pane attach failed", new Error("EIO"))).toBe("[termixion] pane attach failed: EIO");
    expect(formatRecord("connected")).toBe("[termixion] connected");
  });
});

describe("logSink forwarding", () => {
  it("forwards error / warn / info through the invoke seam and still writes to the console", () => {
    const invoke = vi.fn(async () => undefined);
    const { con, sink } = harness(invoke);
    sink.error("pane attach failed", new Error("EIO"));
    sink.warn("config_write failed for font.size", "denied");
    sink.info("connected to core v0.1.1");
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(1, "log_message", { level: "error", message: "[termixion] pane attach failed: EIO" });
    expect(invoke).toHaveBeenNthCalledWith(2, "log_message", { level: "warn", message: "[termixion] config_write failed for font.size: denied" });
    expect(invoke).toHaveBeenNthCalledWith(3, "log_message", { level: "info", message: "[termixion] connected to core v0.1.1" });
    expect(con.error).toHaveBeenCalledWith("[termixion] pane attach failed: EIO");
    expect(con.warn).toHaveBeenCalledTimes(1);
    expect(con.info).toHaveBeenCalledTimes(1);
  });
  it("never throws when the invoke rejects", async () => {
    const { con, sink } = harness(vi.fn(async () => { throw new Error("no runtime"); }));
    expect(() => sink.error("x", "y")).not.toThrow();
    await Promise.resolve();
    expect(con.error).toHaveBeenCalledTimes(1);
  });
  it("never throws even when the detail's JSON and string conversions both throw", () => {
    const hostile = { toJSON: () => { throw new Error("no json"); }, [Symbol.toPrimitive]: () => { throw new Error("no string"); } };
    const invoke = vi.fn(async () => undefined);
    const { con, sink } = harness(invoke);
    expect(() => sink.error("hostile detail", hostile)).not.toThrow();
    expect(con.error).toHaveBeenCalledWith("[termixion] hostile detail: <unprintable detail>");
    expect(invoke).toHaveBeenCalledWith("log_message", { level: "error", message: "[termixion] hostile detail: <unprintable detail>" });
  });
  it("never throws when the invoke throws synchronously (no __TAURI_INTERNALS__)", () => {
    const { con, sink } = harness(() => { throw new TypeError("window.__TAURI_INTERNALS__ is undefined"); });
    expect(() => sink.warn("x")).not.toThrow();
    expect(con.warn).toHaveBeenCalledTimes(1);
  });
});
