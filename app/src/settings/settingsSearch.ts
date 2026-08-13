// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-232: the settings-search primitives. vmark's index-less design: there is NO search index —
// the rendered settings panels ARE the index. The shell (SettingsApp) normalizes the sidebar query
// and broadcasts it through SettingsSearchContext; every SettingRow/SettingsGroup reads it back and
// stamps its own match verdict as data attributes; a scoped stylesheet (settings-search.css) turns
// those attributes into visibility. Keeping the filter in the components themselves means there is
// no parallel searchable index to drift from the UI.
//
// matchesSettingsQuery is the ONE matching rule everything rides on (rows, groups, panels): plain
// case-insensitive substring over label + description + keywords. Callers pass a query already
// normalized by normalizeSettingsQuery; the haystack is lowercased here.
import { createContext, useContext } from "react";

/** The normalized (trimmed, lowercased) live query; "" = not searching. */
export const SettingsSearchContext = createContext("");

/** The current normalized settings-search query ("" outside a provider / while not searching). */
export function useSettingsSearchQuery(): string {
  return useContext(SettingsSearchContext);
}

/** The one query normalization: what the shell stores and every matcher receives. */
export function normalizeSettingsQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Does a row/group with this text content match the (normalized) query? Empty query matches
 * everything — the not-searching state renders every row visible.
 */
export function matchesSettingsQuery(
  query: string,
  label: string,
  description?: string,
  keywords?: readonly string[],
): boolean {
  if (!query) return true;
  const haystack = `${label} ${description ?? ""} ${keywords?.join(" ") ?? ""}`.toLowerCase();
  return haystack.includes(query);
}
