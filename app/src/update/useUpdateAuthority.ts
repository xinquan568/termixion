// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the MAIN window's authoritative update machine. It wraps useUpdate (the real reducer +
// PendingUpdate handle live here and only here) and adds what "automatic updates" means:
//  - the startup/scheduled check (shouldAutoCheck over the persisted prefs + lastCheckAt),
//  - auto-download (available → download when the preference is on, never for a skipped version),
//  - the bus protocol serving other windows: broadcast `update:state` on every transition, answer
//    `update:request-state` with a snapshot, execute `update:command` from projections.
// The bus is optional — with no runtime (plain dev) the authority still works locally.
import { useCallback, useEffect, useRef } from "react";
import type { UpdateClient } from "./updateClient";
import type { SettingsStore } from "../settings/settingsStore";
import type { EventBus } from "../ipc/eventBus";
import { autoCheckSourceFrom, useUpdate, type UseUpdate } from "./useUpdate";
import { shouldAutoCheck } from "./shouldAutoCheck";
import {
  UPDATE_COMMAND_EVENT,
  UPDATE_REQUEST_STATE_EVENT,
  UPDATE_STATE_EVENT,
  isUpdateCommandEnvelope,
} from "./updateEvents";

export interface UseUpdateAuthorityDeps {
  client: UpdateClient;
  settings: SettingsStore;
  /** Cross-window bus; absent in plain dev/jsdom (the authority then runs purely locally). */
  bus?: EventBus;
  /** Injectable clock for the schedule decision + lastCheckAt stamping. */
  now?: () => Date;
  /** This window's tag on broadcasts/commands (echo guard). */
  source?: string;
}

export function useUpdateAuthority({
  client,
  settings,
  bus,
  now = () => new Date(),
  source = "main",
}: UseUpdateAuthorityDeps): UseUpdate {
  const base = useUpdate({ client, store: autoCheckSourceFrom(settings) });

  // Listeners registered once must see the CURRENT actions/state, not a stale closure.
  const latest = useRef({ base, settings, now });
  latest.current = { base, settings, now };

  // Every check — scheduled, local-manual, or command-driven — stamps lastCheckAt at start.
  const checkNow = useCallback(async () => {
    latest.current.settings.saveLastCheckAt(latest.current.now().toISOString());
    await latest.current.base.checkNow();
  }, []);

  // The startup schedule: at most one decision per mount (StrictMode-safe via the ref guard).
  const didSchedule = useRef(false);
  useEffect(() => {
    if (didSchedule.current) return;
    didSchedule.current = true;
    const s = latest.current.settings;
    const decision = shouldAutoCheck(latest.current.now(), {
      autoCheck: s.get("update.autoCheck"),
      frequency: s.get("update.checkFrequency"),
      lastCheckAt: s.loadLastCheckAt(),
    });
    if (decision) void checkNow();
  }, [checkNow]);

  // Auto-download: once per offered version, honoring the preference and a user's Skip.
  const autoDownloadedVersion = useRef<string | null>(null);
  useEffect(() => {
    const s = base.state;
    if (s.status !== "available" || !s.updateInfo) return;
    const version = s.updateInfo.version;
    if (!settings.get("update.autoDownload")) return;
    if (s.dismissedVersion === version) return;
    if (autoDownloadedVersion.current === version) return;
    autoDownloadedVersion.current = version;
    void base.download();
  }, [base.state, base.download, base, settings]);

  // Broadcast every state transition (idempotent full snapshots — late subscribers converge).
  useEffect(() => {
    void bus?.emit(UPDATE_STATE_EVENT, { state: base.state, source });
  }, [bus, base.state, source]);

  // Serve snapshot requests and execute commands from other windows.
  useEffect(() => {
    if (!bus) return;
    let live = true;
    const unsubs: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      p.then((u) => (live ? unsubs.push(u) : u())).catch(() => {
        // No runtime — the authority simply serves nobody.
      });

    keep(
      bus.listen(UPDATE_REQUEST_STATE_EVENT, () => {
        void bus.emit(UPDATE_STATE_EVENT, { state: latest.current.base.state, source });
      }),
    );
    keep(
      bus.listen(UPDATE_COMMAND_EVENT, (payload) => {
        if (!isUpdateCommandEnvelope(payload) || payload.source === source) return;
        const b = latest.current.base;
        switch (payload.cmd.type) {
          case "checkNow":
            void checkNow();
            break;
          case "download":
            void b.download();
            break;
          case "restart":
            void b.restart();
            break;
          case "skip":
            b.skip();
            break;
          case "setAutoCheck":
            b.setAutoCheck(payload.cmd.enabled);
            break;
        }
      }),
    );
    return () => {
      live = false;
      unsubs.forEach((u) => u());
    };
  }, [bus, source, checkNow]);

  return { ...base, checkNow };
}
