// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-5: the frontend↔backend IPC bridge. Pure seams (getCoreVersion / decodePtyFrame / wirePtyChannel)
// are unit-tested with fakes; the real `invoke`/`Channel` edge (realInvoke / openPtyChannel) needs the
// Tauri runtime and is exercised by the real app (`cargo tauri dev`) and the packaged smoke (C-3/D-3).
// C-2 streams live PTY output through this same channel.
import { invoke as tauriInvoke, Channel } from "@tauri-apps/api/core";

/** The `invoke` signature this module depends on — injectable so callers can fake the backend. */
export type InvokeFn = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** Receives decoded PTY output bytes. */
export type PtyBytesHandler = (bytes: Uint8Array) => void;

/** The slice of a Tauri `Channel` this module wires — just the message sink. */
export interface MessageChannel<T> {
  onmessage: (message: T) => void;
}

/** Invoke the placeholder backend command and return the core version (the B-5 handshake). */
export function getCoreVersion(invoke: InvokeFn): Promise<string> {
  // The one place we assert the command's contract: `core_version` returns a string (main.rs).
  return invoke("core_version") as Promise<string>;
}

/** Decode one PTY channel frame (the byte array Rust sends) into bytes. */
export function decodePtyFrame(frame: number[]): Uint8Array {
  return Uint8Array.from(frame);
}

/** Route a PTY channel's messages into `onBytes`, decoding each frame. */
export function wirePtyChannel(
  channel: MessageChannel<number[]>,
  onBytes: PtyBytesHandler,
): void {
  channel.onmessage = (frame) => onBytes(decodePtyFrame(frame));
}

/** The real Tauri `invoke`. In a plain browser (`pnpm dev`) there is no backend, so it rejects. */
export const realInvoke: InvokeFn = tauriInvoke as InvokeFn;

/**
 * Open the PTY-bytes channel against the backend (real edge). Constructs a Tauri `Channel`, wires it
 * to `onBytes`, and asks the backend to stream into it. B-5's `open_pty_channel` emits a single
 * readiness frame so the round-trip is observable; C-2 streams live PTY output.
 */
export async function openPtyChannel(
  onBytes: PtyBytesHandler,
  invoke: InvokeFn = realInvoke,
): Promise<void> {
  const channel = new Channel<number[]>();
  wirePtyChannel(channel, onBytes);
  await invoke("open_pty_channel", { channel });
}
