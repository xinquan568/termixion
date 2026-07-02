// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-41: a Kitty-style vertical scrollbar for the xterm.js terminal — visible ONLY while the view is
// scrolled back into the scrollback (Kitty's default `scrollbar scrolled` policy), hidden at the live
// bottom. Termixion renders via xterm.js (not Kitty's GPU pipeline), so we reproduce Kitty's *behavior
// and style* with a DOM overlay rather than porting its shader.
//
// The module is split the way `mountTerminal.ts` is: a **pure** geometry/visibility core
// (`computeScrollbar`) that takes plain measurements and is unit-testable headless, plus thin DOM helpers
// (`createScrollbarOverlay` / `applyScrollbar`) and an `attachScrollbar` wiring seam over a small terminal
// interface so the xterm dependency is injected at one place (`TerminalView`).
//
// Reference (read from the Kitty source): `kitty/shaders.c` `has_scrollbar` (line 825 — the default
// policy also requires the *main* line buffer to be active and history to exist) and `draw_scrollbar`,
// plus the `scrollbar*` option defaults in `kitty/options/definition.py`.

/** Kitty's scrollbar option defaults, in units of cell width (or cell height for `minHandleHeight`). */
export const KITTY_SCROLLBAR = {
  /** Handle width at rest (`scrollbar_width`). */
  width: 0.5,
  /** Handle width while hovered (`scrollbar_hover_width`). */
  hoverWidth: 1.0,
  /** Gap between the bar and the window's right edge (`scrollbar_gap`). */
  gap: 0.1,
  /** Corner radius of the rounded handle (`scrollbar_radius`). */
  radius: 0.3,
  /** Minimum handle height in cell *heights* (`scrollbar_min_handle_height`). */
  minHandleHeight: 1.0,
  /** Handle opacity (`scrollbar_handle_opacity`). */
  handleOpacity: 0.5,
  /** Track opacity at rest (`scrollbar_track_opacity`) — 0 = invisible. */
  trackOpacity: 0.0,
  /** Track opacity while hovered (`scrollbar_track_hover_opacity`). */
  trackHoverOpacity: 0.1,
} as const;

/** The scroll/buffer state + host measurements the geometry is a pure function of. */
export interface ScrollbarInput {
  /** Visible rows (`Terminal.rows`). */
  rows: number;
  /** Visible columns (`Terminal.cols`) — used to derive the cell width. */
  cols: number;
  /** Top visible buffer line (`buffer.active.viewportY`); equals `baseY` at the live bottom. */
  viewportY: number;
  /** Top line when pinned to the bottom (`buffer.active.baseY`) — i.e. the scrollback line count. */
  baseY: number;
  /** Total buffer lines incl. scrollback (`buffer.active.length`). */
  length: number;
  /** True on the alternate screen (`buffer.active.type === "alternate"`). */
  isAltBuffer: boolean;
  /** Host element width in px (`host.clientWidth`). */
  hostWidthPx: number;
  /** Host element height in px (`host.clientHeight`). */
  hostHeightPx: number;
  /** Whether the pointer is over the scrollbar region. */
  hovering: boolean;
}

/** The resolved overlay geometry, or `{ visible: false }` when the bar must be hidden. */
export type ScrollbarGeometry =
  | { visible: false }
  | {
      visible: true;
      /** Handle width in px (wider when hovering). */
      widthPx: number;
      /** Horizontal gap from the right edge in px. */
      gapPx: number;
      /** Corner radius in px. */
      radiusPx: number;
      /** Track top offset in px (= gap). */
      trackTopPx: number;
      /** Track height in px (host height minus the top+bottom gap). */
      trackHeightPx: number;
      /** Thumb top offset in px within the host. */
      thumbTopPx: number;
      /** Thumb height in px. */
      thumbHeightPx: number;
      /** Handle opacity. */
      handleOpacity: number;
      /** Track opacity (0 at rest, faint on hover). */
      trackOpacity: number;
    };

/**
 * The pure heart of the feature. Mirrors Kitty's `has_scrollbar` (default `scrolled` policy) +
 * `draw_scrollbar`:
 *
 * - **Visibility** — shown iff the *main* buffer is active, scrollback exists, and the view is scrolled
 *   back: `!isAltBuffer && baseY > 0 && baseY - viewportY > 0`. (`baseY > 0` also guards the divide
 *   below.)
 * - **Thumb height** — `max(minHandle, rows / length)` of the track (so it never shrinks below ~1 cell).
 * - **Thumb position** — `scrollProgress = viewportY / baseY` runs 0 (oldest line, thumb at the track
 *   top) → 1 (live bottom, thumb at the track bottom); this is Kitty's `1 - bar_frac`.
 */
export function computeScrollbar(input: ScrollbarInput): ScrollbarGeometry {
  const {
    rows,
    cols,
    viewportY,
    baseY,
    length,
    isAltBuffer,
    hostWidthPx,
    hostHeightPx,
    hovering,
  } = input;

  if (isAltBuffer || baseY <= 0 || baseY - viewportY <= 0) return { visible: false };

  const cellWidth = cols > 0 ? hostWidthPx / cols : 0;
  const cellHeight = rows > 0 ? hostHeightPx / rows : 0;

  const gapPx = KITTY_SCROLLBAR.gap * cellWidth;
  const widthPx = (hovering ? KITTY_SCROLLBAR.hoverWidth : KITTY_SCROLLBAR.width) * cellWidth;
  const radiusPx = KITTY_SCROLLBAR.radius * cellWidth;

  const trackTopPx = gapPx;
  const trackHeightPx = Math.max(0, hostHeightPx - 2 * gapPx);

  const visibleFraction = length > 0 ? rows / length : 1;
  const minFraction =
    trackHeightPx > 0 ? (KITTY_SCROLLBAR.minHandleHeight * cellHeight) / trackHeightPx : 0;
  const thumbHeightFraction = Math.min(1, Math.max(minFraction, visibleFraction));
  const thumbHeightPx = thumbHeightFraction * trackHeightPx;

  // 0 = oldest line (thumb at top) … 1 = live bottom (thumb at bottom). Clamped for safety.
  const scrollProgress = Math.min(1, Math.max(0, viewportY / baseY));
  const thumbTopPx = trackTopPx + scrollProgress * (1 - thumbHeightFraction) * trackHeightPx;

  return {
    visible: true,
    widthPx,
    gapPx,
    radiusPx,
    trackTopPx,
    trackHeightPx,
    thumbTopPx,
    thumbHeightPx,
    handleOpacity: KITTY_SCROLLBAR.handleOpacity,
    trackOpacity: hovering ? KITTY_SCROLLBAR.trackHoverOpacity : KITTY_SCROLLBAR.trackOpacity,
  };
}

/** The three detached elements that make up the overlay: a container holding a track + a thumb. */
export interface ScrollbarOverlay {
  container: HTMLDivElement;
  track: HTMLDivElement;
  thumb: HTMLDivElement;
}

/**
 * Build the overlay DOM (detached). The container is `pointer-events: none` (set in CSS) so it never
 * intercepts the terminal's own clicks/selection — this is a display-only scrollbar.
 */
export function createScrollbarOverlay(doc: Document = document): ScrollbarOverlay {
  const container = doc.createElement("div");
  container.className = "termixion-scrollbar";
  container.setAttribute("aria-hidden", "true");
  container.style.display = "none";

  const track = doc.createElement("div");
  track.className = "termixion-scrollbar__track";

  const thumb = doc.createElement("div");
  thumb.className = "termixion-scrollbar__thumb";

  container.appendChild(track);
  container.appendChild(thumb);
  return { container, track, thumb };
}

/**
 * The theme slice the bar paints from — the xterm `ITheme` fields `buildXtermTheme` emits.
 * trmx-53: per-theme scrollbar tokens ride the standard `scrollbarSlider*` fields; themes (or
 * fakes) without them fall back to the trmx-41 foreground-derived look.
 */
export interface ScrollbarThemeSlice {
  foreground?: string;
  scrollbarSliderBackground?: string;
  scrollbarSliderHoverBackground?: string;
  scrollbarSliderActiveBackground?: string;
}

/** The resolved colors/opacity the overlay is painted with. */
export interface ScrollbarPaint {
  color: string;
  thumbOpacity: number;
}

/**
 * Resolve the bar's paint from the terminal theme. With scrollbar tokens (trmx-53) the token's
 * own alpha is authoritative — the thumb paints at opacity 1 (no double-fade) and hover swaps
 * idle → hover color. Without them, trmx-41's look: the theme foreground at Kitty's fixed handle
 * opacity. (The `active` token is carried for schema parity; this display-only bar has no drag
 * state to consume it.)
 */
export function resolveScrollbarPaint(
  theme: ScrollbarThemeSlice | undefined,
  hovering: boolean,
): ScrollbarPaint {
  const idle = theme?.scrollbarSliderBackground;
  if (idle) {
    const hover = theme?.scrollbarSliderHoverBackground;
    return { color: hovering && hover ? hover : idle, thumbOpacity: 1 };
  }
  return { color: theme?.foreground ?? "#ffffff", thumbOpacity: KITTY_SCROLLBAR.handleOpacity };
}

/**
 * Write a resolved geometry + paint onto the overlay. Pure DOM writes (no reads, no events), so it
 * is testable with plain jsdom divs. When hidden, the container is collapsed via `display: none`.
 * The track shares the paint color but keeps its geometry-driven opacity (invisible at rest, faint
 * on hover — Kitty's track policy).
 */
export function applyScrollbar(
  overlay: ScrollbarOverlay,
  geometry: ScrollbarGeometry,
  paint: ScrollbarPaint,
): void {
  const { container, track, thumb } = overlay;
  if (!geometry.visible) {
    container.style.display = "none";
    return;
  }
  container.style.display = "";

  const px = (n: number) => `${n}px`;

  // Track (invisible at rest; faint on hover). Right-offset by the Kitty gap.
  track.style.right = px(geometry.gapPx);
  track.style.top = px(geometry.trackTopPx);
  track.style.height = px(geometry.trackHeightPx);
  track.style.width = px(geometry.widthPx);
  track.style.borderRadius = px(geometry.radiusPx);
  track.style.background = paint.color;
  track.style.opacity = String(geometry.trackOpacity);

  // Thumb (the visible handle).
  thumb.style.right = px(geometry.gapPx);
  thumb.style.top = px(geometry.thumbTopPx);
  thumb.style.height = px(geometry.thumbHeightPx);
  thumb.style.width = px(geometry.widthPx);
  thumb.style.borderRadius = px(geometry.radiusPx);
  thumb.style.background = paint.color;
  thumb.style.opacity = String(paint.thumbOpacity);
}

/** A minimal disposable, matching xterm's `IDisposable`. */
export interface ScrollbarDisposable {
  dispose(): void;
}

/** The slice of an xterm `Terminal` the scrollbar reads — injected so the wiring is testable headless. */
export interface ScrollbarTerminalLike {
  readonly rows: number;
  readonly cols: number;
  options: { theme?: ScrollbarThemeSlice };
  /** Fires whenever the viewport scrolls. */
  onScroll(handler: () => void): ScrollbarDisposable;
  buffer: {
    readonly active: {
      readonly viewportY: number;
      readonly baseY: number;
      readonly length: number;
      readonly type: "normal" | "alternate";
    };
    /** Fires when the active buffer switches (normal ⇄ alternate) — may NOT fire `onScroll`. */
    onBufferChange(handler: () => void): ScrollbarDisposable;
  };
}

/** A mounted scrollbar: re-evaluate on demand (e.g. after a re-fit) and tear down. */
export interface AttachScrollbarHandle {
  /** Recompute geometry from the current terminal/host state and repaint. */
  recompute(): void;
  /** Unsubscribe listeners and remove the overlay element. */
  dispose(): void;
}

/**
 * Mount the Kitty-style scrollbar over `host` for `terminal`. Subscribes to `onScroll` and
 * `buffer.onBufferChange` (a buffer switch may not fire a scroll event, so the overlay would otherwise go
 * stale on alt-screen enter/leave) and to pointer hover, recomputing the overlay each time. It does NOT
 * observe resize itself — `TerminalView` calls `recompute()` after its fit pass so the read sees the
 * already-resized `rows`/`cols`.
 */
export function attachScrollbar(
  host: HTMLElement,
  terminal: ScrollbarTerminalLike,
  opts: { document?: Document } = {},
): AttachScrollbarHandle {
  const doc = opts.document ?? host.ownerDocument ?? document;
  const overlay = createScrollbarOverlay(doc);
  host.appendChild(overlay.container);

  let hovering = false;

  const recompute = () => {
    const active = terminal.buffer.active;
    const geometry = computeScrollbar({
      rows: terminal.rows,
      cols: terminal.cols,
      viewportY: active.viewportY,
      baseY: active.baseY,
      length: active.length,
      isAltBuffer: active.type === "alternate",
      hostWidthPx: host.clientWidth,
      hostHeightPx: host.clientHeight,
      hovering,
    });
    // trmx-53: colors resolve from the theme's scrollbar tokens (or the trmx-41 foreground
    // fallback); a live theme reassignment is picked up on the next recompute.
    applyScrollbar(overlay, geometry, resolveScrollbarPaint(terminal.options.theme, hovering));
  };

  const scrollSub = terminal.onScroll(recompute);
  const bufferSub = terminal.buffer.onBufferChange(recompute);

  // trmx-41: xterm's public `onScroll` is SUPPRESSED for user-initiated viewport scrolling. A wheel /
  // trackpad / keyboard scroll-back goes through the Viewport, which requests its `scrollLines` with
  // `suppressScrollEvent: true`; `BufferService.scrollLines` then fires `onScroll` only when that flag is
  // false (`t || this._onScroll.fire(...)`). So the bar above would never appear *while the user scrolls*
  // — only for content-driven / programmatic scrolls. The `.xterm-viewport` element's native DOM `scroll`
  // event, by contrast, fires for every viewport move, so we listen there too. xterm registers its own
  // viewport scroll handler during `terminal.open()` (before this attach), so by the time ours runs the
  // buffer's `viewportY` has already been updated. The element is absent under fakes (headless tests with
  // no real xterm DOM); we simply skip it then.
  const viewport = host.querySelector<HTMLElement>(".xterm-viewport");
  const onViewportScroll = () => recompute();
  viewport?.addEventListener("scroll", onViewportScroll, { passive: true });

  // Hover detection: the pointer is "over the scrollbar" when it is within (hover-width + gap) cell
  // widths of the host's right edge. The overlay stays pointer-events:none, so we read pointer x off the
  // host's own mousemove instead of putting an interactive element over the terminal.
  const onMouseMove = (ev: MouseEvent) => {
    const cellWidth = terminal.cols > 0 ? host.clientWidth / terminal.cols : 0;
    const zonePx = (KITTY_SCROLLBAR.hoverWidth + KITTY_SCROLLBAR.gap) * cellWidth;
    const rect = host.getBoundingClientRect();
    const distanceFromRight = rect.left + host.clientWidth - ev.clientX;
    const next = zonePx > 0 && distanceFromRight >= 0 && distanceFromRight <= zonePx;
    if (next !== hovering) {
      hovering = next;
      recompute();
    }
  };
  const onMouseLeave = () => {
    if (hovering) {
      hovering = false;
      recompute();
    }
  };
  host.addEventListener("mousemove", onMouseMove);
  host.addEventListener("mouseleave", onMouseLeave);

  recompute();

  return {
    recompute,
    dispose() {
      scrollSub.dispose();
      bufferSub.dispose();
      viewport?.removeEventListener("scroll", onViewportScroll);
      host.removeEventListener("mousemove", onMouseMove);
      host.removeEventListener("mouseleave", onMouseLeave);
      overlay.container.remove();
    },
  };
}
