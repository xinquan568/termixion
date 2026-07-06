// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-98 (FR-1.5): the per-pane find bar. A compact interactive overlay docked top-right inside the
// focused pane's rect. It drives `@xterm/addon-search` (via the pane's `handle.search`) with a pure
// `findState` reducer. CRITICAL: because the bar autofocuses its input — a non-terminal editable target
// the global keymap's `resolve()` skips — the primary nav chords ⌘G/⇧⌘G (and Esc/Enter/⇧Enter) MUST be
// handled locally here, or they'd silently no-op in the exact state a user hits them. Each mounted bar
// registers an imperative controller {next,prev,close,focus} so App's global commands (terminal-focused
// ⌘G, palette, `[keys]`) route to the RIGHT pane's bar rather than bare handle.search.
import { useEffect, useReducer, useRef } from "react";
import {
  findReducer,
  initialFindState,
  isSearchable,
  countLabel,
  searchOptions,
  type FindState,
  type SearchDecorationColors,
} from "./findState";
import type { SearchLike } from "../terminal/mountTerminal";

/** An injectable one-shot timer for the debounce (real setTimeout in the app; a fake in tests). */
export type Schedule = (fn: () => void, ms: number) => () => void;
const realSchedule: Schedule = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/** The imperative surface a mounted FindBar registers so global commands can drive its pane's search. */
export interface SearchController {
  next(): void;
  prev(): void;
  close(): void;
  focus(): void;
}

export interface FindBarProps {
  search: SearchLike;
  colors: SearchDecorationColors;
  /** Close the bar: clear decorations + return focus to the terminal (App owns both). */
  onClose(): void;
  /** Register/deregister this bar's imperative controller with App (keyed by pane). */
  onRegister(controller: SearchController | null): void;
  /** Debounce interval (ms) + injectable schedule for deterministic tests. */
  debounceMs?: number;
  schedule?: Schedule;
}

export function FindBar({
  search,
  colors,
  onClose,
  onRegister,
  debounceMs = 100,
  schedule = realSchedule,
}: FindBarProps) {
  const [state, dispatch] = useReducer(findReducer, initialFindState);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fresh-state refs so the (once-registered) controller + debounced search read the LATEST values.
  const stateRef = useRef<FindState>(state);
  stateRef.current = state;
  const colorsRef = useRef(colors);
  colorsRef.current = colors;

  // Run the addon for the current state: empty/invalid → clear decorations (no throw); else findNext.
  const runSearch = () => {
    const s = stateRef.current;
    if (!isSearchable(s)) {
      search.clearDecorations();
      return;
    }
    search.findNext(s.query, searchOptions(s, colorsRef.current) as unknown);
  };
  const runSearchRef = useRef(runSearch);
  runSearchRef.current = runSearch;

  // Live match count from the addon (subscription disposed on unmount).
  useEffect(() => {
    const sub = search.onDidChangeResults((e) =>
      dispatch({ type: "setResults", index: e.resultIndex, total: e.resultCount }),
    );
    return () => sub.dispose();
  }, [search]);

  // Register the imperative controller for App's global commands; deregister on unmount + clear state.
  useEffect(() => {
    const controller: SearchController = {
      next: () => {
        const s = stateRef.current;
        if (isSearchable(s)) search.findNext(s.query, searchOptions(s, colorsRef.current) as unknown);
      },
      prev: () => {
        const s = stateRef.current;
        if (isSearchable(s))
          search.findPrevious(s.query, searchOptions(s, colorsRef.current) as unknown);
      },
      close: () => onClose(),
      focus: () => inputRef.current?.focus(),
    };
    onRegister(controller);
    return () => onRegister(null);
    // onClose/onRegister are stable per pane; the controller reads live state via refs — register once.
  }, [search]);

  // Autofocus + select on mount (a fresh bar takes the keyboard).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced incremental search: re-run ~debounceMs after the query/toggles change; cancel a pending
  // run on the next change + on unmount (so a stale query never fires).
  const cancelRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    cancelRef.current?.();
    cancelRef.current = schedule(() => runSearchRef.current(), debounceMs);
    return () => cancelRef.current?.();
  }, [state.query, state.caseSensitive, state.regex, schedule, debounceMs]);

  const next = () => {
    if (isSearchable(stateRef.current))
      search.findNext(stateRef.current.query, searchOptions(stateRef.current, colorsRef.current) as unknown);
  };
  const prev = () => {
    if (isSearchable(stateRef.current))
      search.findPrevious(stateRef.current.query, searchOptions(stateRef.current, colorsRef.current) as unknown);
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    // These are the field-focused equivalents of the (skipped) global keymap; own them locally.
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      onClose();
    } else if (ev.key === "Enter" || (ev.metaKey && (ev.key === "g" || ev.key === "G"))) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.shiftKey) prev();
      else next();
    }
  };

  return (
    <div
      className="tx-find-bar"
      role="search"
      aria-label="Find in terminal"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        className={`tx-find-bar__input${state.error ? " tx-find-bar__input--error" : ""}`}
        type="text"
        aria-label="Find"
        placeholder="Find"
        value={state.query}
        aria-invalid={state.error}
        onChange={(e) => dispatch({ type: "setQuery", query: e.target.value })}
      />
      <span className="tx-find-bar__count" aria-live="polite">
        {countLabel(state)}
      </span>
      <button
        className={`tx-find-bar__toggle${state.caseSensitive ? " tx-find-bar__toggle--on" : ""}`}
        type="button"
        aria-label="Match case"
        aria-pressed={state.caseSensitive}
        title="Match case"
        onClick={() => dispatch({ type: "toggleCase" })}
      >
        Aa
      </button>
      <button
        className={`tx-find-bar__toggle${state.regex ? " tx-find-bar__toggle--on" : ""}`}
        type="button"
        aria-label="Use regular expression"
        aria-pressed={state.regex}
        title="Regular expression"
        onClick={() => dispatch({ type: "toggleRegex" })}
      >
        .*
      </button>
      <button className="tx-find-bar__nav" type="button" aria-label="Previous match" title="Previous (⇧⌘G)" onClick={prev}>
        ‹
      </button>
      <button className="tx-find-bar__nav" type="button" aria-label="Next match" title="Next (⌘G)" onClick={next}>
        ›
      </button>
      <button className="tx-find-bar__close" type="button" aria-label="Close find" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
