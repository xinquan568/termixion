// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-249: the decoder is what keeps the wire-shape change non-regressive, so its edge cases are
// the point — a structured payload, a legacy string, and every malformed shape that could otherwise
// reach a consumer as `[object Object]`.
import { describe, it, expect } from "vitest";
import {
  decodeIpcError,
  BackendError,
  isIpcErrorKind,
  IPC_ERROR_KINDS,
} from "./ipcError";

describe("decodeIpcError", () => {
  it("decodes the structured payload the backend now sends", () => {
    const error = decodeIpcError({ kind: "not_found", message: "no session with id 7" });
    expect(error).toBeInstanceOf(BackendError);
    expect(error.kind).toBe("not_found");
    expect(error.message).toBe("no session with id 7");
  });

  it("keeps a legacy bare-string rejection working", () => {
    const error = decodeIpcError("pty state poisoned");
    expect(error.message).toBe("pty state poisoned");
    expect(error.kind).toBeUndefined();
  });

  it("keeps the message but drops an unknown kind from a newer backend", () => {
    const error = decodeIpcError({ kind: "quantum_flux", message: "something new" });
    expect(error.message).toBe("something new");
    expect(error.kind).toBeUndefined();
  });

  it.each([
    ["null", null, "the backend rejected with null"],
    ["undefined", undefined, "the backend rejected with no reason"],
    ["a number", 42, "the backend rejected with 42"],
    ["an object with no message", { code: 7 }, 'the backend rejected with {"code":7}'],
  ])("never renders [object Object] for %s", (_label, input, expected) => {
    const error = decodeIpcError(input);
    expect(error.message).toBe(expected);
    // The regression this whole change exists to prevent:
    expect(String(error)).not.toContain("[object Object]");
    expect(`${error.message}`).not.toContain("[object Object]");
  });

  it("survives a hostile toJSON without throwing", () => {
    const hostile = {
      toJSON() {
        throw new Error("nope");
      },
    };
    const error = decodeIpcError(hostile);
    expect(error).toBeInstanceOf(BackendError);
    expect(error.message).not.toContain("[object Object]");
  });

  it("survives a circular value without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => decodeIpcError(circular)).not.toThrow();
  });

  it("passes an already-decoded BackendError through unchanged", () => {
    const original = new BackendError("already done", "io");
    expect(decodeIpcError(original)).toBe(original);
  });

  it("reads a real Error's message", () => {
    expect(decodeIpcError(new Error("boom")).message).toBe("boom");
  });

  it("behaves like the string it replaced for every consumer idiom", () => {
    const error = decodeIpcError({ kind: "io", message: "could not create /x" });
    expect(error.message).toBe("could not create /x");
    expect(`${error.message}`).toBe("could not create /x");
    expect(error instanceof Error).toBe(true);
  });
});

describe("IPC_ERROR_KINDS", () => {
  it("accepts every declared kind and rejects anything else", () => {
    for (const kind of IPC_ERROR_KINDS) expect(isIpcErrorKind(kind)).toBe(true);
    for (const junk of ["", "IO", "not-found", 7, null, undefined, {}]) {
      expect(isIpcErrorKind(junk)).toBe(false);
    }
  });
});
