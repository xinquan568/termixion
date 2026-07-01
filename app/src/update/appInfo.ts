// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the app-info seam (Step-5 F3). The About page needs the running version; behind this interface
// the unit tests inject `fakeAppInfo` and the real `@tauri-apps/api/app` edge stays runtime-only.
import { getVersion } from "@tauri-apps/api/app";

/** Version lookup the About page depends on. */
export interface AppInfo {
  getVersion(): Promise<string>;
}

/** The real edge — resolves the packaged app version via Tauri. Runtime-only (not unit-tested). */
export const realAppInfo: AppInfo = {
  getVersion,
};

/** A fixed-version fake for tests. */
export function makeFakeAppInfo(version = "0.0.1"): AppInfo {
  return { getVersion: async () => version };
}
