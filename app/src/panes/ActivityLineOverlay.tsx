// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-91 (sub-task F): the per-pane ACTIVITY LINE overlay — a thin 2px bar pinned to a pane host's
// TOP edge that signals the pane's session is running a foreground job. WHEN it shows is decided
// upstream (activityLine.ts's lightActive ∧ the terminal.activityIndicator setting, combined by App);
// this component is purely presentational and self-gates on the resolved `visible` flag (returns null
// when off — the BadgeOverlay idiom, so App can keep it unconditionally in the pane-host JSX).
//
// (Named `ActivityLineOverlay` — not `ActivityLine` — because the committed pure debounce lives in
// `activityLine.ts`, and a case-only-different filename collides on case-insensitive filesystems.)
//
// trmx-160: the BUSY look is a clone of iTerm2's indeterminate progress bar — an opaque track (black
// in dark mode, white in light) behind a pure-green sweep, rendered as TWO `__sweep` layers phase-
// offset by half a period so a bright blob is always visible. The geometry / track / gradient / motion
// live in the `.tx-activity-line--progress` CSS (index.css, the badge/scrollbar styling split — CSS
// owns everything jsdom can't assert; only `pointer-events: none` stays inline for the css:false test).
// The ERROR FLASH (trmx-99) reuses this overlay with `flashing` — it keeps its original solid-tint
// look (`--flash`, the inline `color` + the legacy shimmer), so the new green visual never bleeds into
// a failed-command flash. z-order (index.css) sits ABOVE the xterm screen and BELOW the badge.

export interface ActivityLineOverlayProps {
  /** Whether the line should be on-screen right now — App combines lightActive ∧ the setting (or a
   * flash). False renders nothing (instant unmount, no fade). */
  visible: boolean;
  /** The error-tint the FLASH variant paints (trmx-99, `color.semantic.error` at alpha). The busy
   * progress bar is theme-independent green, so it ignores this. */
  color: string;
  /** The active theme's mode (`resolveTheme(themeId).isDark`) — selects the progress track / gradient
   * / period (dark: black track, 3s; light: white track, 6s). */
  isDark: boolean;
  /** trmx-99: this pane is flashing a failed command's exit code — render the (unchanged) flash look
   * instead of the busy progress bar. */
  flashing: boolean;
}

/**
 * The pane's activity line, or `null` when it must not show. A `flashing` pane keeps the trmx-99 flash
 * look (a solid error-tint bar); otherwise it renders the trmx-160 iTerm2 progress-bar clone (an
 * opaque `isDark`-keyed track + two phase-offset green sweep layers). All motion + geometry is CSS.
 */
export function ActivityLineOverlay({ visible, color, isDark, flashing }: ActivityLineOverlayProps) {
  if (!visible) return null;
  if (flashing) {
    return (
      <div
        className="tx-activity-line tx-activity-line--flash"
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
  return (
    <div
      className={`tx-activity-line tx-activity-line--progress ${isDark ? "tx-activity-line--dark" : "tx-activity-line--light"}`}
      data-testid="pane-activity"
      aria-hidden="true"
      // Same click-through guarantee; the track + sweep colors are all CSS (theme-independent green).
      style={{ pointerEvents: "none" }}
    >
      <span className="tx-activity-line__sweep" />
      <span className="tx-activity-line__sweep tx-activity-line__sweep--offset" />
    </div>
  );
}
