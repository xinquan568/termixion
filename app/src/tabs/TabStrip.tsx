// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-74: the tab strip — the PRESENTATIONAL bottom bar over the pure tab model (tabState.ts).
// It renders the ordered tabs plus a `+` button and reports intent upward (activate / close /
// new / move); it owns no tab state, so App's reducer stays the single source of truth. Themed
// exclusively via the existing `--tx-*` custom properties (txCssVars.ts — settings.css's `:root`
// fallbacks are in the main window's bundle), styled in index.css.
//
// Drag-to-reorder is pointer-events + setPointerCapture on the tab element: pointerdown records
// the start slot, a move past the 4px slop makes it a drag (under the slop it stays a click →
// activate), each move maps the pointer's DRAG-AXIS coordinate onto a hover slot via sibling
// boundingRect MIDPOINTS (`hoverSlotFor` — exported pure math, unit-tested headless like the
// reducer; `hoverIndexFromPoint` is its x-axis pre-trmx-81 alias), and pointerup commits at most
// ONE `onMove(startIndex, hoverIndex)`. Capture keeps the stream on the tab while the pointer
// roams; jsdom lacks the capture API, so taking it is best-effort.
//
// trmx-75 (FR-2.4): inline rename. Rename STATE lives in App (`renamingTabId` — the strip stays
// presentational); while a tab is renaming, its label is replaced by a seeded, select-all-focused
// <input> that commits on Enter/blur and cancels on Esc. The input is EVENT-ISOLATED from the
// strip: pointerdown/up/click/dblclick/keydown all stopPropagation, so Space types a space, a
// click places the caret without activating, a text-selection drag never engages the reorder
// machinery, and a double-click inside the input never restarts rename.
//
// trmx-81 (FR-2.2): `orientation` — horizontal (default, top/bottom bars: drag on X) or vertical
// (left/right rails: drag on Y, `tab-strip--vertical` keys the side-rail CSS). The D2 drop
// indicator is RENDERED drag feedback (hover state used to live only in dragRef): a 2px accent
// line at the hover slot's leading boundary — vertical at the slot's x on horizontal strips,
// horizontal at the slot's y on vertical rails — present only mid-drag, cleared on release/cancel.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Tab } from "./tabState";

export interface TabStripProps {
  tabs: Tab[];
  activeTabId: number | null;
  /** The tab whose label is currently an inline rename input, or null (trmx-75). */
  renamingTabId: number | null;
  /**
   * The strip's axis (trmx-81): "horizontal" (default — top/bottom bars) or "vertical"
   * (left/right rails). App derives it from barLayoutFor(tabs.barPosition).
   */
  orientation?: "horizontal" | "vertical";
  onActivate: (tabId: number) => void;
  onClose: (tabId: number) => void;
  onNew: () => void;
  onMove: (from: number, to: number) => void;
  /** A label was double-clicked — App activates the tab AND flips it into rename (trmx-75). */
  onRenameStart: (tabId: number) => void;
  /** Enter/blur in the input — the RAW value; App maps empty-after-trim to clear-to-auto. */
  onRenameCommit: (tabId: number, value: string) => void;
  /** Esc in the input — the edit is discarded, nothing committed. */
  onRenameCancel: () => void;
}

/** Movement (in px, straight-line) a pointer may make and still count as a click, not a drag. */
export const DRAG_SLOP_PX = 4;

/** The drag axis (trmx-81): "x" on horizontal strips, "y" on vertical rails. */
export type StripAxis = "x" | "y";

/**
 * The slot a dragged tab hovers over (trmx-81, generalizing hoverIndexFromPoint): the first slot
 * whose MIDPOINT on the drag axis still lies past `pointerCoord` (x-midpoints for axis "x",
 * y-midpoints for "y"), clamping past the last midpoint to the last slot (0 for an empty strip —
 * defensive; the reducer clamps again). Pure math over rect slices so it is unit-testable without
 * layout.
 */
export function hoverSlotFor(
  pointerCoord: number,
  rects: ReadonlyArray<{ left: number; top: number; width: number; height: number }>,
  axis: StripAxis,
): number {
  for (let i = 0; i < rects.length; i++) {
    const mid =
      axis === "x" ? rects[i].left + rects[i].width / 2 : rects[i].top + rects[i].height / 2;
    if (pointerCoord < mid) return i;
  }
  return Math.max(rects.length - 1, 0);
}

/**
 * The pre-trmx-81 x-axis form, kept as a thin delegate so the horizontal slot semantics are one
 * code path (and the trmx-74 unit tests keep pinning them under the original name).
 */
export function hoverIndexFromPoint(
  rects: ReadonlyArray<{ left: number; width: number }>,
  x: number,
): number {
  return hoverSlotFor(
    x,
    rects.map((r) => ({ left: r.left, width: r.width, top: 0, height: 0 })),
    "x",
  );
}

// One in-flight pointer interaction on a tab. `dragging` flips once the slop is exceeded and
// never back — a drag that returns home is still a drag (no activation on release).
interface DragTracking {
  pointerId: number;
  tabId: number;
  startIndex: number;
  startX: number;
  startY: number;
  dragging: boolean;
  hoverIndex: number;
}

// Best-effort pointer capture: keeps pointermove/up streaming to the tab while the pointer leaves
// it mid-drag. jsdom implements no capture (tests dispatch on the element directly), and a stale
// pointer id throws in real DOM — both must stay inert.
function capturePointer(el: Element, pointerId: number): void {
  try {
    (el as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(pointerId);
  } catch {
    // No capture — dragging still works while the pointer stays over the strip.
  }
}

/**
 * The inline rename input (trmx-75). Local controlled state seeded ONCE from the tab's current
 * title (a mid-edit OSC/hint update must not clobber the user's typing — useState ignores later
 * `initial` values); autofocus + select-all on mount so the first keystroke replaces the whole
 * title. `done` latches on the FIRST commit/cancel: Enter commits and the input then unmounts —
 * if the resulting blur (or the unmount's) still lands, it must not commit a second time, and a
 * blur after Esc must not resurrect the cancelled edit.
 */
function TabRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      data-testid="tab-rename-input"
      className="tab-strip__rename"
      aria-label="Rename tab"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      // EVENT ISOLATION (trmx-75 plan requirement): the input sits inside the tab div whose
      // handlers do activation + drag + Enter/Space activation. Nothing from inside the edit may
      // reach them — Space must TYPE, Enter must commit exactly once, a caret click must not
      // activate, a selection drag must not reorder, a dblclick must not restart rename. (⌘1..⌘9
      // are vetoed separately: the window-capture keymap sees an editable non-terminal target.)
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

export function TabStrip({
  tabs,
  activeTabId,
  renamingTabId,
  orientation = "horizontal",
  onActivate,
  onClose,
  onNew,
  onMove,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
}: TabStripProps) {
  const dragRef = useRef<DragTracking | null>(null);
  // trmx-81 D2: the RENDERED drag feedback. dragRef mutations never re-render (deliberately — the
  // hot pointermove path), so the indicator gets its own state: the hover slot's leading-boundary
  // offset within the strip (left for horizontal, top for vertical), or null when not dragging.
  const [indicatorOffset, setIndicatorOffset] = useState<number | null>(null);
  const axis: StripAxis = orientation === "vertical" ? "y" : "x";

  const onTabPointerDown =
    (tab: Tab, index: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return; // primary button only — right/middle click is not a drag
      dragRef.current = {
        pointerId: e.pointerId,
        tabId: tab.tabId,
        startIndex: index,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        hoverIndex: index,
      };
      capturePointer(e.currentTarget, e.pointerId);
    };

  const onTabPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (!drag.dragging) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= DRAG_SLOP_PX) return;
      drag.dragging = true;
    }
    // Measure the CURRENT sibling tabs (the + button carries no data-tabstrip-item, so it never
    // counts as a slot); document order is render order, so indexes line up with the model.
    const strip = e.currentTarget.parentElement;
    if (!strip) return;
    const rects = Array.from(strip.querySelectorAll("[data-tabstrip-item]"), (el) =>
      el.getBoundingClientRect(),
    );
    drag.hoverIndex = hoverSlotFor(axis === "x" ? e.clientX : e.clientY, rects, axis);
    // D2: paint the indicator at the hover slot's leading boundary, in strip-local coordinates
    // (client rect minus the strip's own origin, plus its scroll offset — a scrolled vertical
    // rail must not shift the line).
    const slotRect = rects[drag.hoverIndex];
    if (slotRect) {
      const stripRect = strip.getBoundingClientRect();
      setIndicatorOffset(
        axis === "x"
          ? slotRect.left - stripRect.left + strip.scrollLeft
          : slotRect.top - stripRect.top + strip.scrollTop,
      );
    }
  };

  const onTabPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setIndicatorOffset(null); // release always clears the D2 indicator
    if (drag.dragging) {
      // Commit the reorder exactly once, and only if the tab actually left its slot.
      if (drag.hoverIndex !== drag.startIndex) onMove(drag.startIndex, drag.hoverIndex);
    } else {
      onActivate(drag.tabId); // never exceeded the slop → a plain click
    }
  };

  const onTabPointerCancel = () => {
    dragRef.current = null;
    setIndicatorOffset(null); // cancel clears the D2 indicator too
  };

  return (
    <div
      className={`tab-strip${orientation === "vertical" ? " tab-strip--vertical" : ""}`}
      data-testid="tab-strip"
      role="tablist"
      aria-label="Tabs"
    >
      {tabs.map((tab, index) => {
        const active = tab.tabId === activeTabId;
        return (
          // A div (not a button): the close × inside is a real <button>, and buttons must not
          // nest. Keyboard activation is wired explicitly below.
          <div
            key={tab.tabId}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            data-testid={`tab-${tab.tabId}`}
            data-tabstrip-item=""
            className={`tab-strip__tab${active ? " tab-strip__tab--active" : ""}`}
            onPointerDown={onTabPointerDown(tab, index)}
            onPointerMove={onTabPointerMove}
            onPointerUp={onTabPointerUp}
            onPointerCancel={onTabPointerCancel}
            // trmx-75: double-click on the tab (its label area) starts rename. The handler lives
            // on the DIV, not the label span: pointerdown takes pointer capture for the drag
            // machinery, and captured pointers RETARGET the compatibility click/dblclick to the
            // capture element — a span handler would never fire in a real browser. The close
            // button and the rename input stop their own dblclick so they never reach here.
            onDoubleClick={() => onRenameStart(tab.tabId)}
            onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate(tab.tabId);
              }
            }}
          >
            {tab.tabId === renamingTabId ? (
              <TabRenameInput
                initial={tab.title}
                onCommit={(value) => onRenameCommit(tab.tabId, value)}
                onCancel={onRenameCancel}
              />
            ) : (
              <span className="tab-strip__title" title={tab.title}>
                {tab.title}
              </span>
            )}
            {/* Always in the DOM (CSS reveals it on hover); both the pointer sequence and the
                click stop at the button so closing never drags/activates the tab under it. */}
            <button
              type="button"
              className="tab-strip__close"
              data-testid={`tab-close-${tab.tabId}`}
              aria-label={`Close ${tab.title}`}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()} // never bubbles into rename (trmx-75)
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.tabId);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="tab-strip__new"
        data-testid="tab-new"
        aria-label="New Tab"
        title="New Tab (⌘T)"
        onClick={onNew}
      >
        +
      </button>
      {/* trmx-81 D2: the drop indicator — only mid-drag. The axis modifier names the STRIP's
          orientation; the line itself runs across it (a vertical 2px line at `left` on a
          horizontal strip, a horizontal one at `top` on a vertical rail — the cross-axis extent
          is CSS-owned). No data-tabstrip-item: it must never count as a drag slot. */}
      {indicatorOffset !== null && (
        <div
          className={`tab-strip__indicator tab-strip__indicator--${orientation}`}
          data-testid="tab-strip-indicator"
          style={axis === "x" ? { left: indicatorOffset } : { top: indicatorOffset }}
        />
      )}
    </div>
  );
}
