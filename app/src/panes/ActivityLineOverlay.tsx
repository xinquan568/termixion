// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-91 (sub-task F): the per-pane ACTIVITY LINE overlay — a thin 2px bar pinned to a pane host's
// TOP edge that signals the pane's session is running a foreground job. WHEN it shows is decided
// upstream by the pure debounce (panes/activityLine.ts) plus the terminal.activityIndicator setting;
// this component is purely presentational and self-gates on the resolved `visible` flag (returns null
// when off — the BadgeOverlay idiom, so App can keep it unconditionally in the pane-host JSX).
//
// (Named `ActivityLineOverlay` — not `ActivityLine` — because the committed pure debounce lives in
// `activityLine.ts`, and a case-only-different filename collides on case-insensitive filesystems.
// Same split as the badge: `BadgeOverlay.tsx` (component) vs `badgeVisible.ts` (pure helper).)
//
// Styling split (the badge/scrollbar idiom): the STATIC look — the top-edge inset, the 2px height, the
// clip, the z-order, and the GPU-cheap indeterminate shimmer (a `transform`-only keyframe on a
// `::after` highlight, no JS timers) — lives in the `.tx-activity-line` CSS class (index.css). The
// DYNAMIC bit — the theme-derived color (the active theme's `color.semantic.success` at ~80% alpha,
// resolved by App) — is inline, as is `pointer-events: none` (the load-bearing click-through
// guarantee, which jsdom under Vitest can only assert off the inline style). z-order (index.css) sits
// ABOVE the xterm screen (z-auto) and BELOW the trmx-90 badge (z-index 4), so a badged, busy pane
// shows both without the line fighting the watermark.

export interface ActivityLineOverlayProps {
  /**
   * Whether the line should be on-screen right now — the debounce's `isVisible` ∧ the
   * `terminal.activityIndicator` setting (App combines both). False renders nothing.
   */
  visible: boolean;
  /** The active theme's `color.semantic.success` at ~80% alpha (App resolves + applies the alpha). */
  color: string;
}

/**
 * The pane's activity line, or `null` when it must not show. App threads the resolved `visible` gate
 * and the theme color; all the motion + geometry is CSS (`.tx-activity-line`).
 */
export function ActivityLineOverlay({ visible, color }: ActivityLineOverlayProps) {
  if (!visible) return null;
  return (
    <div
      className="tx-activity-line"
      data-testid="pane-activity"
      aria-hidden="true"
      style={{
        backgroundColor: color,
        // Load-bearing + jsdom-assertable: the line never intercepts the terminal's own clicks.
        pointerEvents: "none",
      }}
    />
  );
}
