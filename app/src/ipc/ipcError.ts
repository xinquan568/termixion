// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-249: the frontend half of the typed IPC rejection contract.
//
// Every fallible `#[tauri::command]` now rejects with `{ kind, message }` (crates/termixion-tauri/
// src/ipc_error.rs) instead of a bare string. That is a WIRE SHAPE CHANGE, and an undecoded object
// rejection is worse than the string it replaces: `String(err)` on a plain object renders
// `[object Object]`, which is exactly what settingsStore.ts and the About rows would have shown.
//
// So decoding is not a convenience here — it is what keeps the change non-regressive. `realInvoke`
// routes every rejection through `decodeIpcError`, and the result is always an Error subclass whose
// `.message` is the human text, so `String(err)`, `err.message` and a bare template interpolation
// all keep working exactly as they did when the wire carried a string.

/**
 * The rejection classes the backend can send.
 *
 * ONE runtime tuple, with the union DERIVED from it — not a hand-written union beside a hand-written
 * array, which drift silently. `ipcErrorGolden.test.ts` compares this tuple against the Rust-derived
 * vocabulary in the shared golden fixture, so a variant added in Rust fails here.
 */
export const IPC_ERROR_KINDS = [
  "not_found",
  "not_running",
  "spawn",
  "invalid_size",
  "io",
  "invalid",
  "internal",
] as const;

export type IpcErrorKind = (typeof IPC_ERROR_KINDS)[number];

/** True when `value` is one of the known kinds. */
export function isIpcErrorKind(value: unknown): value is IpcErrorKind {
  return (
    typeof value === "string" && (IPC_ERROR_KINDS as readonly string[]).includes(value)
  );
}

/**
 * A decoded backend rejection. Extends `Error`, so every existing consumer — `String(err)`,
 * `err.message`, `log.error("...", err)` — behaves as it did when the wire carried a string.
 *
 * `kind` is `undefined` for a legacy bare-string rejection or a payload we could not read, which is
 * how a caller distinguishes "the backend told me why" from "something else went wrong".
 */
export class BackendError extends Error {
  readonly kind?: IpcErrorKind;

  constructor(message: string, kind?: IpcErrorKind) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
  }
}

/**
 * Decode any rejection value into a `BackendError`. Total by construction — it never throws and
 * never returns a non-Error, because a decoder that can itself fail just moves the problem.
 *
 * Handles, in order: an already-decoded BackendError; the structured `{ kind, message }` payload; a
 * structured payload with an UNKNOWN kind (a newer backend — keep the message, drop the kind rather
 * than lying about it); a legacy bare string; a real `Error`; and anything else.
 */
export function decodeIpcError(value: unknown): BackendError {
  // EVERY inspection is guarded, including `instanceof` and property reads. A rejection can be a
  // Proxy or an object with a throwing getter, and a decoder that throws while decoding hands
  // realInvoke an undecoded rejection — which is exactly the `[object Object]` this prevents.
  try {
    if (value instanceof BackendError) return value;

    if (typeof value === "string") return new BackendError(value);

    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const message = record.message;
      if (typeof message === "string") {
        // An unknown `kind` means a backend newer than this bundle. The message is still the truth,
        // so keep it and leave `kind` undefined rather than asserting a class we do not understand.
        const kind = record.kind;
        return new BackendError(message, isIpcErrorKind(kind) ? kind : undefined);
      }
      if (value instanceof Error) return new BackendError(value.message);
    }
  } catch {
    // A throwing getter, a hostile Proxy trap, a revoked Proxy.
    return new BackendError("the backend rejected with an unreadable value");
  }

  // A malformed payload: null, a number, an object with no message. Never render `[object Object]`.
  return new BackendError(describeOpaque(value));
}

/** A last-resort human string for a payload that carried no message. */
function describeOpaque(value: unknown): string {
  if (value === undefined) return "the backend rejected with no reason";
  if (value === null) return "the backend rejected with null";
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return `the backend rejected with ${json}`;
  } catch {
    // a circular or hostile toJSON — fall through
  }
  return "the backend rejected with an unreadable value";
}
