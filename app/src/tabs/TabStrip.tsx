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
// activate), each move maps the pointer x onto a hover slot via sibling boundingRect MIDPOINTS
// (`hoverIndexFromPoint` — exported pure math, unit-tested headless like the reducer), and
// pointerup commits at most ONE `onMove(startIndex, hoverIndex)`. Capture keeps the stream on the
// tab while the pointer roams; jsdom lacks the capture API, so taking it is best-effort.
//
// trmx-75 (FR-2.4): inline rename. Rename STATE lives in App (`renamingTabId` — the strip stays
// presentational); while a tab is renaming, its label is replaced by a seeded, select-all-focused
// <input> that commits on Enter/blur and cancels on Esc. The input is EVENT-ISOLATED from the
// strip: pointerdown/up/click/dblclick/keydown all stopPropagation, so Space types a space, a
// click places the caret without activating, a text-selection drag never engages the reorder
// machinery, and a double-click inside the input never restarts rename.
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

/**
 * The slot a dragged tab hovers over: the first slot whose horizontal MIDPOINT still lies right
 * of `x`, clamping past the last midpoint to the last slot (0 for an empty strip — defensive; the
 * reducer clamps again). Pure math over `{left, width}` rects so it is unit-testable without
 * layout.
 */
export function hoverIndexFromPoint(
  rects: ReadonlyArray<{ left: number; width: number }>,
  x: number,
): number {
  for (let i = 0; i < rects.length; i++) {
    if (x < rects[i].left + rects[i].width / 2) return i;
  }
  return Math.max(rects.length - 1, 0);
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
  onActivate,
  onClose,
  onNew,
  onMove,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
}: TabStripProps) {
  const dragRef = useRef<DragTracking | null>(null);

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
    drag.hoverIndex = hoverIndexFromPoint(rects, e.clientX);
  };

  const onTabPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (drag.dragging) {
      // Commit the reorder exactly once, and only if the tab actually left its slot.
      if (drag.hoverIndex !== drag.startIndex) onMove(drag.startIndex, drag.hoverIndex);
    } else {
      onActivate(drag.tabId); // never exceeded the slop → a plain click
    }
  };

  const onTabPointerCancel = () => {
    dragRef.current = null;
  };

  return (
    <div className="tab-strip" data-testid="tab-strip" role="tablist" aria-label="Tabs">
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
    </div>
  );
}
