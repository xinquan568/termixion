// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the About page. Shows app identity (icon + name + version) and the Website / GitHub
// links, and hosts the auto-update UX. trmx-51 brings it to vmark-0.8.18 parity: the links stack
// vertically with leading icons, the Updates group carries the four rows (Automatic updates,
// Check frequency, Download updates automatically, Check for updates), and a Reset group restores
// every persisted setting behind an inline confirmation. Presentational: it takes an already-wired
// `update` (authority or mirror), plus injected `appInfo`/`opener`/`settings` seams, so it is
// unit-tested with fakes and the real Tauri edge stays out of the test path.
// trmx-80 (FR-13): a Configuration group with "Open config file" — the row's description shows
// where config.toml lives (getConfigFilePath, hydrated at boot) and the button opens it through
// the opener seam. A plain browser has no config file (null path), so the group hides entirely.
import { useEffect, useState } from "react";
import { Button, ProgressBar, Select, SettingRow, SettingsGroup, StatusPill, Toggle } from "./components";
import { GitHubIcon, GlobeIcon } from "./icons";
import type { AppInfo } from "../update/appInfo";
import type { Opener } from "../update/opener";
import type { UseUpdate } from "../update/useUpdate";
import { isCardVisible, progressPercent, type UpdateState } from "../update/updateState";
import {
  getConfigFilePath,
  SETTING_DEFAULTS,
  type CheckFrequency,
  type SettingsStore,
} from "./settingsStore";
import appIcon from "../assets/app-icon.png";

// For now the website and the repository are the same address (the issue): both link to the GitHub repo.
const WEBSITE_URL = "https://github.com/xinquan568/termixion";
const GITHUB_URL = "https://github.com/xinquan568/termixion";

const FREQUENCY_OPTIONS: ReadonlyArray<{ value: CheckFrequency; label: string }> = [
  { value: "on-startup", label: "On startup" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "manual", label: "Manual only" },
];

export interface AboutSettingsProps {
  update: UseUpdate;
  appInfo: AppInfo;
  opener: Opener;
  settings: SettingsStore;
}

export function AboutSettings({ update, appInfo, opener, settings }: AboutSettingsProps) {
  const { state } = update;
  // Hydrated before any window renders (main.tsx boot order); null in a plain browser.
  const configPath = getConfigFilePath();
  const [version, setVersion] = useState<string>("");
  const [frequency, setFrequency] = useState<CheckFrequency>(() =>
    settings.get("update.checkFrequency"),
  );
  const [autoDownload, setAutoDownload] = useState<boolean>(() =>
    settings.get("update.autoDownload"),
  );
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    let live = true;
    appInfo
      .getVersion()
      .then((v) => live && setVersion(v))
      .catch(() => live && setVersion("unknown"));
    return () => {
      live = false;
    };
  }, [appInfo]);

  const resetEverything = () => {
    settings.resetAll();
    // The reducer holds autoCheckEnabled; bring it back to its default alongside the store.
    update.setAutoCheck(SETTING_DEFAULTS["update.autoCheck"]);
    setFrequency(SETTING_DEFAULTS["update.checkFrequency"]);
    setAutoDownload(SETTING_DEFAULTS["update.autoDownload"]);
    setConfirmingReset(false);
  };

  return (
    <div className="tx-about">
      <SettingsGroup>
        <div className="tx-about__identity">
          <img className="tx-about__icon" src={appIcon} alt="Termixion" />
          <div>
            <div className="tx-about__name">Termixion</div>
            <div className="tx-about__version">Version {version}</div>
          </div>
          <ul className="tx-about__links" aria-label="Links">
            <li>
              <button type="button" className="tx-about__link" onClick={() => opener.openExternal(WEBSITE_URL)}>
                <GlobeIcon />
                Website
              </button>
            </li>
            <li>
              <button type="button" className="tx-about__link" onClick={() => opener.openExternal(GITHUB_URL)}>
                <GitHubIcon />
                GitHub
              </button>
            </li>
          </ul>
        </div>
      </SettingsGroup>

      {isCardVisible(state) && state.updateInfo ? (
        <SettingsGroup title="Update available">
          <div className="tx-about__card">
            <div className="tx-about__card-head">
              <span className="tx-about__card-version">Version {state.updateInfo.version}</span>
              {state.updateInfo.currentVersion ? (
                <span className="tx-about__card-current">
                  (current {state.updateInfo.currentVersion})
                </span>
              ) : null}
            </div>
            {state.updateInfo.date ? (
              <div className="tx-about__card-date">Released {state.updateInfo.date}</div>
            ) : null}
            {state.updateInfo.notes ? (
              <div className="tx-about__card-notes">{state.updateInfo.notes}</div>
            ) : null}

            <div className="tx-about__card-actions">
              {state.status === "available" ? (
                <>
                  <Button variant="primary" onClick={() => void update.download()}>
                    Download
                  </Button>
                  <Button variant="tertiary" onClick={() => update.skip()}>
                    Skip
                  </Button>
                </>
              ) : null}
              {state.status === "ready" ? (
                <Button variant="success" onClick={() => void update.restart()}>
                  Restart to update
                </Button>
              ) : null}
            </div>

            {state.status === "downloading" ? (
              <div className="tx-about__progress">
                <ProgressBar percent={progressPercent(state.progress)} />
                <span className="tx-about__progress-label">
                  {progressPercent(state.progress)}%
                </span>
              </div>
            ) : null}
          </div>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Updates">
        <SettingRow
          label="Automatic updates"
          description="Periodically check for new versions"
        >
          <Toggle
            checked={state.autoCheckEnabled}
            onChange={(v) => update.setAutoCheck(v)}
            label="Automatic updates"
          />
        </SettingRow>
        <SettingRow label="Check frequency" description="How often to check for updates">
          <Select
            value={frequency}
            options={FREQUENCY_OPTIONS}
            label="Check frequency"
            onChange={(value) => {
              setFrequency(value);
              settings.set("update.checkFrequency", value);
            }}
          />
        </SettingRow>
        <SettingRow
          label="Download updates automatically"
          description="Download new versions in the background when available"
        >
          <Toggle
            checked={autoDownload}
            label="Download updates automatically"
            onChange={(value) => {
              setAutoDownload(value);
              settings.set("update.autoDownload", value);
            }}
          />
        </SettingRow>
        <SettingRow label="Check for updates">
          <div className="tx-about__check">
            <StatusIndicator state={state} />
            <Button
              variant="tertiary"
              onClick={() => void update.checkNow()}
              disabled={
                state.status === "checking" ||
                state.status === "downloading" ||
                state.status === "ready"
              }
            >
              {state.status === "checking" ? "Checking…" : "Check Now"}
            </Button>
          </div>
        </SettingRow>
      </SettingsGroup>

      {configPath ? (
        <SettingsGroup title="Configuration">
          <SettingRow label="Open config file" description={configPath}>
            <Button variant="tertiary" onClick={() => void opener.openExternal(configPath)}>
              Open
            </Button>
          </SettingRow>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Reset">
        <SettingRow
          label="Reset all settings"
          description="Restore every setting to its default value"
        >
          {confirmingReset ? (
            <div className="tx-about__reset-confirm">
              <span className="tx-about__reset-question">Reset everything?</span>
              <Button variant="danger" onClick={resetEverything}>
                Reset
              </Button>
              <Button variant="tertiary" onClick={() => setConfirmingReset(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirmingReset(true)}>
              Reset to Defaults
            </Button>
          )}
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}

/** The inline status text next to "Check Now", mapping each state to a pill. */
function StatusIndicator({ state }: { state: UpdateState }) {
  switch (state.status) {
    case "checking":
      return <StatusPill tone="info">Checking for updates…</StatusPill>;
    case "up-to-date":
      return <StatusPill tone="success">Termixion is up to date</StatusPill>;
    case "available":
      return (
        <StatusPill tone="info">
          Update available{state.updateInfo ? ` (${state.updateInfo.version})` : ""}
        </StatusPill>
      );
    case "downloading":
      return <StatusPill tone="info">Downloading…</StatusPill>;
    case "ready":
      return <StatusPill tone="success">Ready to install</StatusPill>;
    case "error":
      return <StatusPill tone="error">{state.error ?? "Update check failed"}</StatusPill>;
    default:
      return null;
  }
}
