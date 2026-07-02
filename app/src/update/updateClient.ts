// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the update-client seam. `UpdateClient` is the narrow surface the useUpdate hook depends on, so
// the flow is unit-testable with `makeFakeUpdateClient` and the real Tauri-plugin edge stays isolated in
// realUpdateClient.ts (runtime-only, like ipc/backend.ts realInvoke). Mirrors the repo's inject-the-edge
// pattern.
import type { DownloadProgress, UpdateInfo } from "./updateState";

/** What `check()` resolves to: either no update, or a handle that can download+install itself. */
export interface CheckResult {
  /** An available update, or null when already current. */
  update: PendingUpdate | null;
}

/** An update the endpoint offered — carries its metadata and knows how to download+install itself. */
export interface PendingUpdate {
  info: UpdateInfo;
  /** Download and install; `onProgress` is called as bytes arrive. Resolves when staged and ready. */
  downloadAndInstall(onProgress: (p: DownloadProgress) => void): Promise<void>;
}

/** The seam the UI drives. */
export interface UpdateClient {
  /** Ask the endpoint whether a newer signed release exists. */
  check(): Promise<CheckResult>;
  /** Relaunch the app to apply a staged update. */
  relaunch(): Promise<void>;
}

/** Options for the in-memory fake used by tests. */
export interface FakeUpdateClientOptions {
  /** The update to offer, or null for "up to date". */
  update?: UpdateInfo | null;
  /** Make `check()` reject with this message. */
  checkError?: string;
  /** Make `downloadAndInstall()` reject with this message. */
  downloadError?: string;
  /** Progress ticks the fake emits during download (defaults to one 0% and one 100% tick). */
  progressTicks?: DownloadProgress[];
  /** Collects relaunch calls so a test can assert it fired. */
  onRelaunch?: () => void;
}

/**
 * A deterministic in-memory UpdateClient for unit tests — no Tauri, no network. Returns the configured
 * update, streams the configured progress ticks, and records relaunch.
 */
export function makeFakeUpdateClient(opts: FakeUpdateClientOptions = {}): UpdateClient {
  const ticks = opts.progressTicks ?? [
    { downloaded: 0, total: 100 },
    { downloaded: 100, total: 100 },
  ];
  return {
    async check() {
      if (opts.checkError) throw new Error(opts.checkError);
      if (!opts.update) return { update: null };
      const info = opts.update;
      const pending: PendingUpdate = {
        info,
        async downloadAndInstall(onProgress) {
          if (opts.downloadError) throw new Error(opts.downloadError);
          for (const t of ticks) onProgress(t);
        },
      };
      return { update: pending };
    },
    async relaunch() {
      opts.onRelaunch?.();
    },
  };
}
