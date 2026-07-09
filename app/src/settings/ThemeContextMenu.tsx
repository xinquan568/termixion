// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-171: the theme swatch's right-click context menu — a small in-DOM popover (the app has no
// reusable menu primitive; the native macOS menu bar is unrelated). AppearanceSettings owns a single
// `menu` state ({x, y, entry} | null), so at most one popover is open. It renders here fixed at the
// pointer, holds one "Duplicate" item that runs the existing duplicateBuiltin, and dismisses on
// Escape / an outside pointerdown / after the item is chosen. The position is clamped into the
// window on mount (best-effort; jsdom has no layout, so the Playwright settings e2e verifies the real
// near-edge geometry). Right-click-only is a deliberate trmx-171 decision — no keyboard affordance.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function ThemeContextMenu({
  x,
  y,
  label,
  onDuplicate,
  onClose,
}: {
  /** Viewport coordinates of the right-click (the menu anchors here, then clamps into the window). */
  x: number;
  y: number;
  /** The theme label, appended to the item's accessible name ("Duplicate Night"). */
  label?: string;
  /** Run the duplicate action (AppearanceSettings passes duplicateBuiltin bound to the entry). */
  onDuplicate: () => void;
  /** Close the popover (clears the owner's menu state). Called on Escape / outside-click / select. */
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Keep the popover inside the window: if it would overflow the right/bottom edge, shift it back.
  // jsdom returns a zero-size rect, so this is a no-op there (the e2e checks the real clamp).
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nx = rect.width && x + rect.width > window.innerWidth
      ? Math.max(0, window.innerWidth - rect.width)
      : x;
    const ny = rect.height && y + rect.height > window.innerHeight
      ? Math.max(0, window.innerHeight - rect.height)
      : y;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  // Focus the item (so the menu reads as focused for Escape); dismiss on Escape or an outside
  // pointerdown. Both listeners are removed on unmount so a later key/pointer never hits a stale one.
  useEffect(() => {
    itemRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="tx-theme-menu"
      style={{ position: "fixed", left: pos.x, top: pos.y }}
    >
      <button
        ref={itemRef}
        type="button"
        role="menuitem"
        className="tx-theme-menu__item"
        onClick={() => {
          onDuplicate();
          onClose();
        }}
      >
        Duplicate{label ? ` ${label}` : ""}
      </button>
    </div>
  );
}
