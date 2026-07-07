// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-144: the confirm-before-close dialog — an in-app themed overlay on the PaletteOverlay
// chassis (backdrop div + role box + React onKeyDown on the root), NOT a native dialog, so it
// styles with the --tx-* theme vars and stays jsdom-testable. Kitty-style keys with a safe
// default: Cancel is focused on mount, y/Y confirms (carrying the "don't ask again" checkbox),
// n/N/Escape cancels, Enter only activates the FOCUSED button (never a global confirm), and
// Tab/Shift+Tab cycle the three controls — a minimal focus trap so a modal floating over a live
// terminal never leaks keys or focus into it. Every handled key is preventDefault +
// stopPropagation'd for the same reason. Purely presentational: the caller (App) decides WHETHER
// to show it (closeGuard.ts) and what the busy program names are.
import { useRef, useState } from "react";

export interface ConfirmCloseDialogProps {
  kind: "pane" | "tab" | "quit";
  /** The busy running-program names (already deduped/ordered by closeGuard); [] = no program line. */
  names: string[];
  /** Quit only: how many tabs have running programs — the summary line ("2 tabs have…"). */
  busyTabCount?: number;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

const QUESTION = {
  pane: "Close this pane?",
  tab: "Close this tab?",
  quit: "Quit Termixion?",
} as const;

const CONFIRM_LABEL = { pane: "Close", tab: "Close Tab", quit: "Quit" } as const;

const DIALOG_LABEL = {
  pane: "Confirm close pane",
  tab: "Confirm close tab",
  quit: "Confirm quit",
} as const;

/** At most this many names are spelled out; the rest fold into "+N more". */
const MAX_NAMES = 3;

/** "vim, cargo, top +2 more" — the first MAX_NAMES joined, the overflow counted. */
export function formatNames(names: string[]): string {
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const extra = names.length - MAX_NAMES;
  return extra > 0 ? `${shown} +${extra} more` : shown;
}

export function ConfirmCloseDialog({
  kind,
  names,
  busyTabCount,
  onConfirm,
  onCancel,
}: ConfirmCloseDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const checkboxRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Swallow every key this dialog handles — nothing may fall through to the terminal / keymap.
    const swallow = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "y" || event.key === "Y") {
      swallow();
      onConfirm(dontAskAgain);
      return;
    }
    if (event.key === "n" || event.key === "N" || event.key === "Escape") {
      swallow();
      onCancel();
      return;
    }
    if (event.key === "Enter") {
      // Enter activates the FOCUSED button only — never a global confirm. On the checkbox (or
      // anywhere else) it is swallowed doing nothing; Space still toggles the checkbox natively.
      swallow();
      const active = document.activeElement;
      if (active === confirmRef.current) onConfirm(dontAskAgain);
      else if (active === cancelRef.current) onCancel();
      return;
    }
    if (event.key === "Tab") {
      // Minimal focus trap: cycle checkbox -> Cancel -> confirm (DOM order), wrapping both ways.
      swallow();
      const order = [checkboxRef.current, cancelRef.current, confirmRef.current].filter(
        (el): el is HTMLInputElement | HTMLButtonElement => el !== null,
      );
      if (order.length === 0) return;
      const index = order.findIndex((el) => el === document.activeElement);
      const step = event.shiftKey ? -1 : 1;
      const next =
        index === -1
          ? order[event.shiftKey ? order.length - 1 : 0]
          : order[(index + step + order.length) % order.length];
      next.focus();
    }
  };

  return (
    <div
      className="tx-confirm-close-overlay"
      data-testid="confirm-close"
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="tx-confirm-close"
        role="alertdialog"
        aria-modal="true"
        aria-label={DIALOG_LABEL[kind]}
      >
        <p className="tx-confirm-close__title">{QUESTION[kind]}</p>
        {kind === "quit" && busyTabCount !== undefined && busyTabCount > 0 && (
          <p className="tx-confirm-close__programs">
            {busyTabCount === 1
              ? "1 tab has a running program."
              : `${busyTabCount} tabs have running programs.`}
          </p>
        )}
        {names.length === 1 && (
          <p className="tx-confirm-close__programs">
            <code>{names[0]}</code> is still running.
          </p>
        )}
        {names.length > 1 && (
          <p className="tx-confirm-close__programs">Still running: {formatNames(names)}.</p>
        )}
        <label className="tx-confirm-close__check">
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={dontAskAgain}
            onChange={(event) => setDontAskAgain(event.target.checked)}
          />
          {"Don't ask me again"}
        </label>
        <div className="tx-confirm-close__actions">
          <button
            ref={cancelRef}
            type="button"
            className="tx-confirm-close__btn"
            autoFocus
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="tx-confirm-close__btn tx-confirm-close__btn--danger"
            onClick={() => onConfirm(dontAskAgain)}
          >
            {CONFIRM_LABEL[kind]}
          </button>
        </div>
      </div>
    </div>
  );
}
