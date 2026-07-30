// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
// trmx-225: the focus-follows-mouse decision — pure, so every no-action outcome is directly
// testable instead of inferred from the absence of a render change. App's pane-host
// mouse-move handler assembles the context from live refs and dispatches only on `true`.

/**
 * True exactly when hovering should move pane focus. POSITIONAL primitives, deliberately —
 * the caller sits on a high-frequency mouse-move path and must not allocate a context
 * object per event (the frozen event-cadence requirement).
 *
 * - `enabled`: the live `terminal.focusFollowsMouse` setting.
 * - `moved`: did the pointer actually move since the last observed position? Layout reflow
 *   under a stationary cursor re-targets elements without movement — never refocus then.
 * - `targetIsFocused`: the hovered pane is already its tab's focused pane.
 * - `suspended`: any keyboard-owning overlay or drag is active (rename, badge editor, open
 *   find bar, close-confirm dialog, script picker, pane re-dock pickup, divider drag).
 */
export function shouldFocusOnHover(
  enabled: boolean,
  moved: boolean,
  targetIsFocused: boolean,
  suspended: boolean,
): boolean {
  return enabled && moved && !targetIsFocused && !suspended;
}
