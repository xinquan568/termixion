// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the About page — the only page under Settings. Shows app identity (icon + name + version) and
// the Website / GitHub links, and hosts the whole auto-update UX (auto-check toggle, "Check now" +
// status, and the update-available card). Presentational: it takes an already-wired `update` (useUpdate),
// plus injected `appInfo`/`opener` seams, so it is unit-tested with fakes and the real Tauri edge stays
// out of the test path.
import { useEffect, useState } from "react";
import { Button, ProgressBar, SettingRow, SettingsGroup, StatusPill, Toggle } from "./components";
import type { AppInfo } from "../update/appInfo";
import type { Opener } from "../update/opener";
import type { UseUpdate } from "../update/useUpdate";
import { isCardVisible, progressPercent, type UpdateState } from "../update/updateState";
import appIcon from "../assets/app-icon.png";

// For now the website and the repository are the same address (the issue): both link to the GitHub repo.
const WEBSITE_URL = "https://github.com/xinquan568/termixion";
const GITHUB_URL = "https://github.com/xinquan568/termixion";

export interface AboutSettingsProps {
  update: UseUpdate;
  appInfo: AppInfo;
  opener: Opener;
}

export function AboutSettings({ update, appInfo, opener }: AboutSettingsProps) {
  const { state } = update;
  const [version, setVersion] = useState<string>("");

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

  return (
    <div className="tx-about">
      <SettingsGroup>
        <div className="tx-about__identity">
          <img className="tx-about__icon" src={appIcon} alt="Termixion" />
          <div>
            <div className="tx-about__name">Termixion</div>
            <div className="tx-about__version">Version {version}</div>
          </div>
          <ul className="tx-about__links">
            <li>
              <button type="button" className="tx-about__link" onClick={() => opener.openExternal(WEBSITE_URL)}>
                Website
              </button>
            </li>
            <li>
              <button type="button" className="tx-about__link" onClick={() => opener.openExternal(GITHUB_URL)}>
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

      <SettingsGroup title="Software update">
        <SettingRow
          label="Check for updates automatically"
          description="When on, Termixion checks for a newer version on launch."
        >
          <Toggle
            checked={state.autoCheckEnabled}
            onChange={(v) => update.setAutoCheck(v)}
            label="Check for updates automatically"
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
              {state.status === "checking" ? "Checking…" : "Check now"}
            </Button>
          </div>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}

/** The inline status text next to "Check now", mapping each state to a pill. */
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
