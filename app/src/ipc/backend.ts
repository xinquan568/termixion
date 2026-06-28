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

/** Encode xterm keystroke input (a string from `onData`) to the byte array `pty_write` expects. */
export function encodePtyInput(data: string): number[] {
  return Array.from(new TextEncoder().encode(data));
}

/** The real Tauri `invoke`. In a plain browser (`pnpm dev`) there is no backend, so it rejects. */
export const realInvoke: InvokeFn = tauriInvoke as InvokeFn;

/**
 * Open the live PTY session against the backend (real edge, ADR-0001). Constructs a Tauri `Channel`,
 * wires its frames to `onBytes` (PTY output → the terminal), and asks the backend to spawn the shell
 * at `rows`x`cols` and stream into the channel.
 */
export async function openPty(
  onBytes: PtyBytesHandler,
  rows: number,
  cols: number,
  invoke: InvokeFn = realInvoke,
): Promise<void> {
  const channel = new Channel<number[]>();
  wirePtyChannel(channel, onBytes);
  await invoke("open_pty", { channel, rows, cols });
}

/** Send keystrokes (an xterm `onData` string) to the PTY. */
export function sendPtyInput(
  data: string,
  invoke: InvokeFn = realInvoke,
): Promise<void> {
  return invoke("pty_write", { data: encodePtyInput(data) }).then(() => {});
}

/** Tell the backend the PTY's character grid resized (from xterm `onResize`). */
export function sendPtyResize(
  rows: number,
  cols: number,
  invoke: InvokeFn = realInvoke,
): Promise<void> {
  return invoke("pty_resize", { rows, cols }).then(() => {});
}
