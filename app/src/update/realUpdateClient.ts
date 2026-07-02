// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the REAL update client — the only place that touches the Tauri updater/process plugins. Like
// `ipc/backend.ts realInvoke`, this edge is runtime-only (exercised by the packaged app / release, not by
// headless unit tests); all update *logic* is tested against the `UpdateClient` interface via a fake.
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { CheckResult, PendingUpdate, UpdateClient } from "./updateClient";

export const realUpdateClient: UpdateClient = {
  async check(): Promise<CheckResult> {
    const update = await check();
    if (!update) return { update: null };

    let downloaded = 0;
    let total: number | undefined;
    const pending: PendingUpdate = {
      info: {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body || undefined,
        date: update.date || undefined,
      },
      async downloadAndInstall(onProgress) {
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              total = event.data.contentLength;
              downloaded = 0;
              onProgress({ downloaded, total });
              break;
            case "Progress":
              downloaded += event.data.chunkLength;
              onProgress({ downloaded, total });
              break;
            case "Finished":
              onProgress({ downloaded: total ?? downloaded, total });
              break;
          }
        });
      },
    };
    return { update: pending };
  },

  async relaunch() {
    await relaunch();
  },
};
