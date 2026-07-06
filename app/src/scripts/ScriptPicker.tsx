// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-93 (FR-5): the script picker overlay — a keyboard-first fuzzy list over the discovered
// scripts. trmx-94: now a thin wrapper over the generic `PaletteOverlay` (the command palette shares
// the same chassis); this file keeps the script-specific data loading (the injected `invoke` seam +
// the `scripts:changed` reload, monotonic-id-guarded) and the row shape (name + relPath). The DOM
// contract — `data-testid="script-picker"`, the `tx-script-picker*` classes, the aria labels — is
// preserved so the trmx-93 tests stay green.
import { useEffect, useState } from "react";
import { realInvoke, type InvokeFn } from "../ipc/backend";
import { PaletteOverlay } from "../commands/PaletteOverlay";
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

  // Load the catalog on mount and re-load on a `scripts:changed` signal. No runtime → [] (inert).
  // A monotonic request id guards against out-of-order resolution — a slow initial load must not
  // clobber a fresher reload triggered by a scripts:changed while it was in flight.
  useEffect(() => {
    let live = true;
    let latest = 0;
    const reload = () => {
      const id = ++latest;
      listScripts(invoke).then((entries) => {
        if (live && id === latest) setScripts(entries);
      });
    };
    reload();
    const teardown = onScriptsChanged(reload);
    return () => {
      live = false;
      teardown();
    };
  }, [invoke]);

  return (
    <PaletteOverlay
      items={scripts}
      filterKey={(entry) => entry.relPath}
      itemKey={(entry) => entry.relPath}
      renderItem={(entry) => (
        <>
          <span className="tx-script-picker__name">{entry.name}</span>
          <span className="tx-script-picker__path">{entry.relPath}</span>
        </>
      )}
      onRun={onRun}
      onCancel={onCancel}
      placeholder="Run a script…"
      dialogLabel="Run a script"
      inputAriaLabel="Filter scripts"
      listAriaLabel="Scripts"
      emptyText="No scripts — add files to ~/.config/termixion/scripts/"
      testId="script-picker"
      classPrefix="tx-script-picker"
    />
  );
}
