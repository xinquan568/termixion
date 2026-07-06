// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-98 (FR-1.5): the PURE per-pane find-bar state machine. No DOM, no xterm, no addon — just the
// query/toggle/count/error model + the mapping to `@xterm/addon-search`'s ISearchOptions. Each open
// FindBar owns one of these (per-pane isolation: two bars in a split have independent state). The addon
// itself is upstream-tested; this module is what OUR suite pins (R8, the RED start).

/** Match/active-match highlight colors, from the theme's `terminal.search` tokens. */
export interface SearchDecorationColors {
  match: string;
  activeMatch: string;
}

export interface FindState {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  /** 0-based index of the active match; -1 when there are none. */
  index: number;
  total: number;
  /** true when `regex` is on and `query` is not a valid RegExp — the field shows the error ring. */
  error: boolean;
}

export const initialFindState: FindState = {
  query: "",
  caseSensitive: false,
  regex: false,
  index: -1,
  total: 0,
  error: false,
};

export type FindAction =
  | { type: "setQuery"; query: string }
  | { type: "toggleCase" }
  | { type: "toggleRegex" }
  | { type: "setResults"; index: number; total: number }
  | { type: "reset" };

/** Whether `pattern` compiles as a RegExp (guards the regex path so an invalid pattern never throws). */
export function isValidRegex(pattern: string): boolean {
  try {
    void new RegExp(pattern); // compiles? — `void` marks the constructor call as intentionally unused
    return true;
  } catch {
    return false;
  }
}

/** Recompute the derived `error` flag for the current query/regex. */
function withError(state: FindState): FindState {
  const error = state.regex && state.query.length > 0 && !isValidRegex(state.query);
  // An errored (or empty) query has no results.
  return error ? { ...state, error: true, index: -1, total: 0 } : { ...state, error: false };
}

export function findReducer(state: FindState, action: FindAction): FindState {
  switch (action.type) {
    case "setQuery":
      return withError({ ...state, query: action.query });
    case "toggleCase":
      return { ...state, caseSensitive: !state.caseSensitive };
    case "toggleRegex":
      return withError({ ...state, regex: !state.regex });
    case "setResults":
      // The addon reports results; ignore while in the error state (stale) — it stays 0/0.
      return state.error ? state : { ...state, index: action.index, total: action.total };
    case "reset":
      return initialFindState;
    default:
      return state;
  }
}

/** Whether a search should actually run for this state (non-empty, valid). */
export function isSearchable(state: FindState): boolean {
  return state.query.length > 0 && !state.error;
}

/**
 * The count label shown in the bar: `"3/17"` (1-based active/total), `"0/0"` when a searchable query has
 * no matches, and `""` when the query is empty (nothing to show). The error ring is a separate visual.
 */
export function countLabel(state: FindState): string {
  if (state.query.length === 0) return "";
  if (state.error || state.total === 0) return "0/0";
  return `${state.index + 1}/${state.total}`;
}

/**
 * Map the state + theme colors to `@xterm/addon-search`'s ISearchOptions. The overview-ruler colors are
 * required by the addon's decoration typings, so they mirror the match/active colors.
 */
export function searchOptions(state: FindState, colors: SearchDecorationColors) {
  return {
    regex: state.regex,
    caseSensitive: state.caseSensitive,
    decorations: {
      matchBackground: colors.match,
      matchOverviewRuler: colors.match,
      activeMatchBackground: colors.activeMatch,
      activeMatchBorder: colors.activeMatch,
      activeMatchColorOverviewRuler: colors.activeMatch,
    },
  };
}
