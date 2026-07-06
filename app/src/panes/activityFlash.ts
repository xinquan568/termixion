// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-99 (FR-7b): the exit-code flash policy — the pure decision behind the failure cue. On OSC 133
// `D;<non-zero>` the activity line flashes the theme's `semantic.error` for FLASH_MS (even though the
// command just finished and busy is now false), then disappears. Success (`D;0`) and an absent/non-numeric
// exit code produce NO flash; a new command (`C`) cancels it. App owns the per-pane timer + the flashing
// set (React state, which drives the overlay re-render); this module is the pure, tested policy.

/** How long the error flash paints after a failed command finishes (ms). */
export const FLASH_MS = 600;

/**
 * Whether a finished command should flash the error color. Only a well-formed NON-ZERO exit code flashes;
 * a zero exit (success) or an absent/non-numeric code (`undefined`) does not.
 */
export function shouldFlash(exitCode: number | undefined): boolean {
  return exitCode !== undefined && exitCode !== 0;
}
