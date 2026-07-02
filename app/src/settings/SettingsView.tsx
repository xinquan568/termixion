// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the Settings overlay. Settings has a single page — About — so the overlay simply frames the
// About page over the terminal. Presentational: it takes an already-wired `update` plus the injected
// appInfo/opener seams, so it is unit-tested with fakes (SettingsHost does the real wiring). Closes on
// Escape or a backdrop click.
import { useEffect } from "react";
import { AboutSettings } from "./AboutSettings";
import "./settings.css";
import type { AppInfo } from "../update/appInfo";
import type { Opener } from "../update/opener";
import type { UseUpdate } from "../update/useUpdate";

export interface SettingsViewProps {
  open: boolean;
  onClose: () => void;
  update: UseUpdate;
  appInfo: AppInfo;
  opener: Opener;
}

export function SettingsView({ open, onClose, update, appInfo, opener }: SettingsViewProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="tx-settings-overlay" onClick={onClose}>
      <div
        className="tx-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="tx-settings-panel__header">
          <h1 className="tx-settings-panel__title">Settings</h1>
          <button
            type="button"
            className="tx-settings-panel__close"
            aria-label="Close settings"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="tx-settings-panel__body">
          <AboutSettings update={update} appInfo={appInfo} opener={opener} />
        </div>
      </div>
    </div>
  );
}
