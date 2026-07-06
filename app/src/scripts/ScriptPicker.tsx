// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-93 (FR-5): the script picker overlay — a keyboard-first fuzzy list over the discovered
// scripts. Type to filter (the shared pure fuzzy module, so FR-9's palette can reuse it), ↑/↓ to
// move, Enter to run the highlighted script in the requested surface, Esc (or a backdrop click) to
// cancel. Deliberately shaped like a palette page so FR-9 (#94) can absorb it. The catalog rides an
// injected `invoke` seam and re-loads on `scripts:changed`; without a Tauri runtime it shows empty.
import { useEffect, useMemo, useState } from "react";
import { realInvoke, type InvokeFn } from "../ipc/backend";
import { fuzzyFilter } from "./fuzzy";
import { listScripts, onScriptsChanged, type ScriptEntry } from "./scriptsBackend";

export interface ScriptPickerProps {
  /** Run the chosen script (App sets up the surface + sources it). */
  onRun: (entry: ScriptEntry) => void;
  /** Dismiss without running (Esc / backdrop click). */
  onCancel: () => void;
  /** The backend edge for `scripts_list`; injected so tests drive a fake. */
  invoke?: InvokeFn;
}

export function ScriptPicker({ onRun, onCancel, invoke = realInvoke }: ScriptPickerProps) {
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  // Load the catalog on mount and re-load on a `scripts:changed` signal. No runtime → [] (inert).
  useEffect(() => {
    let live = true;
    const reload = () => {
      listScripts(invoke).then((entries) => {
        if (live) setScripts(entries);
      });
    };
    reload();
    const teardown = onScriptsChanged(reload);
    return () => {
      live = false;
      teardown();
    };
  }, [invoke]);

  const filtered = useMemo(
    () => fuzzyFilter(query, scripts, (entry) => entry.relPath),
    [query, scripts],
  );

  // A new filter re-selects the top (best) result so Enter runs the obvious choice.
  useEffect(() => setSelected(0), [query]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = filtered[selected];
      if (entry) onRun(entry);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className="tx-script-picker-overlay"
      data-testid="script-picker"
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel(); // backdrop click cancels
      }}
    >
      <div className="tx-script-picker" role="dialog" aria-label="Run a script">
        <input
          autoFocus
          className="tx-script-picker__input"
          type="text"
          placeholder="Run a script…"
          aria-label="Filter scripts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className="tx-script-picker__list" role="listbox" aria-label="Scripts">
          {filtered.length === 0 ? (
            <li className="tx-script-picker__empty">
              No scripts — add files to ~/.config/termixion/scripts/
            </li>
          ) : (
            filtered.map((entry, index) => (
              <li
                key={entry.relPath}
                role="option"
                aria-selected={index === selected}
                className={`tx-script-picker__item${
                  index === selected ? " tx-script-picker__item--active" : ""
                }`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => onRun(entry)}
              >
                <span className="tx-script-picker__name">{entry.name}</span>
                <span className="tx-script-picker__path">{entry.relPath}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
