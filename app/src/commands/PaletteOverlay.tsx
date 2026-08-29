// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94 (FR-9.2): the generic keyboard-first fuzzy overlay — extracted from trmx-93's ScriptPicker
// so the command palette AND the script picker share ONE chassis (type to fuzzy-filter, ↑/↓ move,
// Enter run, Esc / backdrop cancel). Purely presentational + generic over the item type: the caller
// supplies the items, the fuzzy key, the React key, how to render a row, and the class prefix / a11y
// strings. Data loading (scripts, commands, themes) stays in the caller.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fuzzyFilter } from "../scripts/fuzzy";

export interface PaletteOverlayProps<T> {
  items: T[];
  /** The string a row is fuzzy-matched against. */
  filterKey: (item: T) => string;
  /** A stable React key per row. */
  itemKey: (item: T) => string;
  /** The row's inner content (name, path, binding hint, …). */
  renderItem: (item: T) => ReactNode;
  onRun: (item: T) => void;
  onCancel: () => void;
  placeholder: string;
  /** The dialog's accessible name (distinct from the input's, so getByLabelText stays unambiguous). */
  dialogLabel: string;
  inputAriaLabel: string;
  listAriaLabel: string;
  emptyText: string;
  /** `data-testid` on the overlay root. */
  testId: string;
  /** BEM class prefix: `${prefix}-overlay`, `${prefix}`, `${prefix}__input/__list/__item[--active]/__empty`. */
  classPrefix: string;
  /** Optional initial query (the command palette seeds "" ; unused elsewhere). */
  initialQuery?: string;
}

export function PaletteOverlay<T>({
  items,
  filterKey,
  itemKey,
  renderItem,
  onRun,
  onCancel,
  placeholder,
  dialogLabel,
  inputAriaLabel,
  listAriaLabel,
  emptyText,
  testId,
  classPrefix,
  initialQuery = "",
}: PaletteOverlayProps<T>) {
  const [query, setQuery] = useState(initialQuery);
  // trmx-291: the selection is held in a REF as well as state. A key handler can be re-entered
  // before React commits the next render — two keystrokes inside one batch, which key-repeat or a
  // fast typist produces — and a closure read of `selected` would then see the PRE-move index.
  // ↑/↓ were already safe (functional updater); Enter was not, and it RUNS the item, so the stale
  // read meant executing the wrong script. The ref is the authority for reads inside handlers; the
  // state drives rendering. Both are written through `select`, so they cannot drift.
  const [selected, setSelectedState] = useState(0);
  const selectedRef = useRef(0);
  const select = (next: number) => {
    selectedRef.current = next;
    setSelectedState(next);
  };

  const filtered = useMemo(() => fuzzyFilter(query, items, filterKey), [query, items, filterKey]);

  // A new filter — or a refreshed item list — re-selects the top result (keeps the highlight in range).
  useEffect(() => select(0), [query, items]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      select(Math.min(selectedRef.current + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      select(Math.max(selectedRef.current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Read the ref, not the closure: this handler may not have re-rendered since the ↑/↓ above.
      // A stale `filtered` can only make this index out of range, which is inert (no run) — never
      // the wrong item.
      const item = filtered[selectedRef.current];
      if (item !== undefined) onRun(item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className={`${classPrefix}-overlay`}
      data-testid={testId}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className={classPrefix} role="dialog" aria-label={dialogLabel}>
        <input
          autoFocus
          className={`${classPrefix}__input`}
          type="text"
          placeholder={placeholder}
          aria-label={inputAriaLabel}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className={`${classPrefix}__list`} role="listbox" aria-label={listAriaLabel}>
          {filtered.length === 0 ? (
            <li className={`${classPrefix}__empty`}>{emptyText}</li>
          ) : (
            filtered.map((item, index) => (
              <li
                key={itemKey(item)}
                role="option"
                aria-selected={index === selected}
                className={`${classPrefix}__item${index === selected ? ` ${classPrefix}__item--active` : ""}`}
                onMouseEnter={() => select(index)}
                onClick={() => onRun(item)}
              >
                {renderItem(item)}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
