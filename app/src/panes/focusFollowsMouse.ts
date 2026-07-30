// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
// trmx-225: the focus-follows-mouse decision — pure, so every no-action outcome is directly
// testable instead of inferred from the absence of a render change. App's pane-host
// mouse-move handler assembles the context from live refs and dispatches only on `true`.

/** Everything the hover-focus decision depends on, assembled per event. */
export interface FfmContext {
  /** The live `terminal.focusFollowsMouse` setting. */
  enabled: boolean;
  /** Did the pointer actually move since the last observed position? Layout reflow under a
   * stationary cursor re-targets elements without movement — those must never refocus. */
  moved: boolean;
  /** Is the hovered pane already the focused pane of its tab? */
  targetIsFocused: boolean;
  /** Is any keyboard-owning overlay or drag interaction active? (rename, badge editor, open
   * find bar, close-confirm dialog, script picker, pane re-dock pickup, divider drag) */
  suspended: boolean;
}

/** True exactly when hovering should move pane focus. */
export function shouldFocusOnHover(ctx: FfmContext): boolean {
  return ctx.enabled && ctx.moved && !ctx.targetIsFocused && !ctx.suspended;
}
