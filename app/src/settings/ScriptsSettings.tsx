// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-93 (FR-5): the Scripts page — a "Startup script" row (a Select over the discovered scripts,
// "None" first) plus an "Open scripts folder" affordance and a hint documenting the `source`
// semantics + the fish caveat. Mirrors AppearanceSettings' themes surface: the startup value
// persists through the injected settings store (which broadcasts settings:changed so the running
// app applies it next launch), and the scripts catalog comes from the backend edge (listScripts /
// openScriptsDir) via an injected `invoke` seam so tests drive a fake. Presentational + injected.
import { useEffect, useState } from "react";
import { SettingRow, SettingsGroup } from "./components";
import { Select } from "./components";
import type { SettingsStore } from "./settingsStore";
import { realInvoke, type InvokeFn } from "../ipc/backend";
import { listScripts, onScriptsChanged, openScriptsDir, type ScriptEntry } from "../scripts/scriptsBackend";

/** The scripting docs (folder layout, source semantics, startup, fish caveat) — the hint links here. */
const SCRIPTS_DOC_URL = "https://github.com/xinquan568/termixion/blob/main/docs/scripts.md";

/** The Select value for "no startup script". Empty string is the stored value for "none". */
const NONE_VALUE = "";

export interface ScriptsSettingsProps {
  settings: SettingsStore;
  /** The backend edge for the scripts-dir actions (list / open). Injected so tests drive a fake. */
  invoke?: InvokeFn;
}

export function ScriptsSettings({ settings, invoke = realInvoke }: ScriptsSettingsProps) {
  // The startup value stays local (seeded from the injected store at mount, the settings-row
  // pattern); a write goes through settings.set, whose broadcast is what the main window applies.
  const [startup, setStartup] = useState<string>(() => settings.get("scripts.startup"));
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);

  // Load the script catalog on mount and re-load on a `scripts:changed` signal (a dropped/edited
  // script file). Without a Tauri runtime listScripts resolves [] and the subscription is inert.
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

  const chooseStartup = (value: string) => {
    setStartup(value);
    settings.set("scripts.startup", value);
  };

  const openFolder = () => {
    openScriptsDir(invoke).catch((err: unknown) => {
      console.warn("[termixion] opening the scripts folder failed", err);
    });
  };

  const options = [
    { value: NONE_VALUE, label: "None" },
    ...scripts.map((entry) => ({ value: entry.relPath, label: entry.relPath })),
  ];

  return (
    <div className="tx-scripts-settings">
      <SettingsGroup title="Startup script">
        <SettingRow
          label="Run on launch"
          description="A script sourced in the first tab when Termixion starts"
        >
          <Select
            value={startup}
            options={options}
            label="Startup script"
            onChange={chooseStartup}
          />
        </SettingRow>
        <div className="tx-scripts-actions">
          <button type="button" className="tx-btn" onClick={openFolder}>
            Open scripts folder
          </button>
          <p className="tx-scripts-hint">
            Scripts live under <code>~/.config/termixion/scripts/</code> (nested folders group them).
            Running one <strong>sources</strong> it into the shell — a <code>cd</code> or alias
            persists — so it needs POSIX <code>source</code> (zsh/bash; fish differs).{" "}
            <a
              className="tx-scripts-hint__link"
              href={SCRIPTS_DOC_URL}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
            .
          </p>
        </div>
      </SettingsGroup>
    </div>
  );
}
