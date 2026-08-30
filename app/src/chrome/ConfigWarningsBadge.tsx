// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-238 (M19): the main window's config-warnings badge. The warnings ledger, the banner and the
// publish/subscribe machinery all existed already (trmx-80) — but `config:warnings` had exactly one
// consumer, the settings window. A hand-edited typo in termixion.toml was therefore invisible from
// the terminal window, which is where the user actually is. This is the missing consumer.
//
// It subscribes to the STORE, never to the raw Tauri event: the store is the single warnings
// authority (trmx-80 review R2) because it alone merges the client-authored ledger — which no
// backend event carries — and sees the empty-set broadcast that clears a stale banner. Initial
// state is seeded from getConfigWarnings() rather than waiting for a change, since hydrateSettings
// is awaited before first paint (main.tsx) and the first broadcast may long precede this mount.
//
// Dismissal matches SettingsApp's rule exactly, so the two surfaces cannot drift: dismissing hides
// the badge until the NEXT non-empty set arrives — a new problem is never buried by an old
// dismissal, and an empty set renders nothing anyway.

import { useEffect, useState } from "react";
import {
  getConfigWarnings,
  onConfigWarningsChanged,
  type ConfigWarningItem,
} from "../store/settingsStore";

export interface ConfigWarningsBadgeProps {
  /** Open the settings window (App wires this to the `open_settings_window` command). */
  onOpenSettings: () => void;
}

export function ConfigWarningsBadge({ onOpenSettings }: ConfigWarningsBadgeProps) {
  const [warnings, setWarnings] = useState<ConfigWarningItem[]>(() => getConfigWarnings());
  const [dismissed, setDismissed] = useState(false);

  useEffect(
    () =>
      onConfigWarningsChanged((items) => {
        setWarnings(items);
        // Un-dismiss on every change: a fresh non-empty set is a NEW problem, and an empty set
        // renders nothing regardless — so this can never resurrect a banner the user silenced.
        setDismissed(false);
      }),
    [],
  );

  if (dismissed || warnings.length === 0) return null;

  const count = warnings.length;
  const label = `Config file has ${count} warning${count === 1 ? "" : "s"} — open Settings`;

  return (
    <span className="config-warnings">
      <button
        type="button"
        className="config-warnings__button"
        // The full text is the tooltip: the badge itself must stay narrow — it shares the
        // title-bar right slot with the AI-session counter.
        title={warnings.map((w) => w.message).join("\n")}
        aria-label={label}
        onClick={onOpenSettings}
      >
        <span aria-hidden="true">⚠</span> {count}
      </button>
      <button
        type="button"
        className="config-warnings__dismiss"
        aria-label="Dismiss config warnings"
        onClick={() => setDismissed(true)}
      >
        <span aria-hidden="true">×</span>
      </button>
    </span>
  );
}
