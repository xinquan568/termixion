// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-99 (FR-7b): OSC 133 (FTCS) shell-integration parsing + the per-session prompt state machine. The
// shell emits `OSC 133;A` (prompt start), `;B` (input start), `;C` (command output start = RUNNING), and
// `;D;<exit>` (finished) around each prompt; "busy" is exactly a C→D window, plus an exit code the FR-7a
// poller could never see. Pure logic over narrow slices (no DOM/React); the machine OWNS the phase and
// emits a TRANSITION so App applies the activity change from `busyChanged` (re-sync included), never from
// the raw marker kind. Follows the trmx-64 OSC discipline: inert on junk, always consume, never throw.

/** A parsed OSC 133 marker. `exit` is set only for `D` with a well-formed non-negative integer code. */
export interface Osc133Marker {
  kind: "A" | "B" | "C" | "D";
  exit?: number;
}

/**
 * Parse the OSC 133 payload (the bytes after `133;`). `A`/`B`/`C` carry no params; `D`'s first sub-param
 * is the exit code (extra iTerm2 sub-params are ignored; absent/non-numeric → `exit: undefined`). Anything
 * outside the implemented `A|B|C|D` family → `null` (silently ignored by the handler).
 */
export function parseOsc133(payload: string): Osc133Marker | null {
  const parts = payload.split(";");
  const kind = parts[0];
  if (kind !== "A" && kind !== "B" && kind !== "C" && kind !== "D") return null;
  if (kind === "D") {
    const raw = parts[1];
    const exit = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
    return { kind, exit };
  }
  return { kind };
}

/** The prompt phase: at the prompt, taking input, or running a command. */
export type PromptPhase = "prompt" | "input" | "running";

export interface PromptState {
  phase: PromptPhase;
}

export function initialPrompt(): PromptState {
  return { phase: "prompt" };
}

/**
 * The transition a marker produces. `busyChanged` is what App keys the activity line on; `exitCode` is
 * carried on `D` (App flashes the error color for a non-zero code). Re-sync is baked in: an `A` while
 * running clears busy (a command ended without a `D`); a double `C` stays running (busyChanged false); a
 * `D` with no preceding `C` reports idle (no spurious busy).
 */
export interface PromptTransition {
  state: PromptState;
  kind: Osc133Marker["kind"];
  busy: boolean;
  busyChanged: boolean;
  exitCode?: number;
}

/** Advance the prompt machine by one marker. Total + pure (any marker re-syncs to a valid phase). */
export function stepPrompt(state: PromptState, marker: Osc133Marker): PromptTransition {
  const wasBusy = state.phase === "running";
  let phase: PromptPhase;
  let exitCode: number | undefined;
  switch (marker.kind) {
    case "A": // prompt start — if a command was running, it ended without a `D` (re-sync to done)
      phase = "prompt";
      break;
    case "B": // input start
      phase = "input";
      break;
    case "C": // command output start — now RUNNING
      phase = "running";
      break;
    case "D": // command finished
      phase = "prompt";
      exitCode = marker.exit;
      break;
  }
  const busy = phase === "running";
  return { state: { phase }, kind: marker.kind, busy, busyChanged: busy !== wasBusy, exitCode };
}

/** The xterm parser slice `attachOsc133` drives (fake-testable). */
export interface Osc133TerminalLike {
  readonly parser: {
    registerOscHandler(ident: number, callback: (data: string) => boolean): { dispose(): void };
  };
}

/**
 * Register the OSC 133 handler on a terminal. It OWNS a `PromptState` for the session and, on each valid
 * marker, advances the machine and hands the resulting `PromptTransition` to `emit`. Junk is inert, the
 * handler ALWAYS returns true (consumes the sequence so it never prints or falls through), and never
 * throws. Returns a teardown that disposes the handler.
 */
export function attachOsc133(
  terminal: Osc133TerminalLike,
  emit: (transition: PromptTransition) => void,
): () => void {
  let state = initialPrompt();
  const handler = terminal.parser.registerOscHandler(133, (data) => {
    try {
      const marker = parseOsc133(data);
      if (marker) {
        const transition = stepPrompt(state, marker);
        state = transition.state;
        emit(transition);
      }
    } catch {
      // Untrusted input — never let a malformed 133 sequence break the terminal.
    }
    return true; // consume the OSC so it never reaches another handler or prints as garbage
  });
  return () => handler.dispose();
}
