// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the About page spec — identity + version, links both to the GitHub URL, status indicator per
// state, and the update-available card actions. Uses a fake useUpdate + fake appInfo/opener seams.
// trmx-51: vmark-0.8.18 parity — icon-led stacked links, the four Updates rows (Automatic updates,
// Check frequency, Download updates automatically, Check for updates), and the Reset section with an
// inline confirmation driving resetAllSettings.
// trmx-80 (FR-13): the Configuration group — "Open config file" opens the hydrated config path
// through the opener seam and shows the path as secondary text; a plain browser (null path) hides it.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSettings } from "./AboutSettings";
import { makeFakeAppInfo } from "../update/appInfo";
import { makeFakeOpener } from "../update/opener";
import type { UseUpdate } from "../update/useUpdate";
import { initialUpdateState, type UpdateState } from "../update/updateState";
import {
  __resetSettingsForTest,
  hydrateSettings,
  makeSettingsStore,
  type KeyValueStore,
  type SettingsStore,
} from "./settingsStore";

const GITHUB_URL = "https://github.com/xinquan568/termixion";

function fakeUpdate(state: Partial<UpdateState> = {}): UseUpdate {
  return {
    state: { ...initialUpdateState(true), ...state },
    checkNow: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    skip: vi.fn(),
    setAutoCheck: vi.fn(),
  };
}

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function renderAbout(
  update: UseUpdate,
  opener = makeFakeOpener(),
  settings: SettingsStore = makeSettingsStore(fakeStorage()),
) {
  render(
    <AboutSettings update={update} appInfo={makeFakeAppInfo("0.0.1")} opener={opener} settings={settings} />,
  );
  return opener;
}

describe("AboutSettings identity", () => {
  it("shows the app name and resolved version", async () => {
    renderAbout(fakeUpdate());
    expect(screen.getByText("Termixion")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Version 0.0.1")).toBeInTheDocument());
  });

  it("opens BOTH links to the GitHub URL", () => {
    const opener = renderAbout(fakeUpdate());
    screen.getByRole("button", { name: "Website" }).click();
    screen.getByRole("button", { name: "GitHub" }).click();
    expect(opener.opened).toEqual([GITHUB_URL, GITHUB_URL]);
  });

  it("stacks the links vertically, each led by its icon (vmark parity)", () => {
    renderAbout(fakeUpdate());
    const list = screen.getByRole("list", { name: "Links" });
    expect(list.className).toContain("tx-about__links");
    const buttons = [
      screen.getByRole("button", { name: "Website" }),
      screen.getByRole("button", { name: "GitHub" }),
    ];
    for (const b of buttons) {
      expect(b.querySelector("svg")).not.toBeNull(); // the leading icon
    }
  });
});

describe("AboutSettings Updates rows (vmark 0.8.18 parity)", () => {
  it("renders the four rows with the screenshot's exact labels and descriptions", () => {
    renderAbout(fakeUpdate());
    expect(screen.getByText("Automatic updates")).toBeInTheDocument();
    expect(screen.getByText("Periodically check for new versions")).toBeInTheDocument();
    expect(screen.getByText("Check frequency")).toBeInTheDocument();
    expect(screen.getByText("How often to check for updates")).toBeInTheDocument();
    expect(screen.getByText("Download updates automatically")).toBeInTheDocument();
    expect(
      screen.getByText("Download new versions in the background when available"),
    ).toBeInTheDocument();
    expect(screen.getByText("Check for updates")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check Now" })).toBeInTheDocument();
  });

  it("Check Now triggers a check and the Automatic-updates toggle drives setAutoCheck", () => {
    const update = fakeUpdate();
    renderAbout(update);
    screen.getByRole("button", { name: "Check Now" }).click();
    expect(update.checkNow).toHaveBeenCalledOnce();
    screen.getByRole("switch", { name: "Automatic updates" }).click();
    expect(update.setAutoCheck).toHaveBeenCalledWith(false);
  });

  it("the frequency select defaults to On startup and persists a change", () => {
    const store = makeSettingsStore(fakeStorage());
    renderAbout(fakeUpdate(), makeFakeOpener(), store);
    const select = screen.getByRole("combobox", { name: "Check frequency" }) as HTMLSelectElement;
    expect(select.value).toBe("on-startup");
    expect([...select.options].map((o) => o.label)).toEqual([
      "On startup",
      "Daily",
      "Weekly",
      "Manual only",
    ]);
    fireEvent.change(select, { target: { value: "weekly" } });
    expect(store.get("update.checkFrequency")).toBe("weekly");
    expect(select.value).toBe("weekly");
  });

  it("the auto-download toggle defaults on and persists a change", () => {
    const store = makeSettingsStore(fakeStorage());
    renderAbout(fakeUpdate(), makeFakeOpener(), store);
    const toggle = screen.getByRole("switch", { name: "Download updates automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    toggle.click();
    expect(store.get("update.autoDownload")).toBe(false);
  });
});

describe("AboutSettings status indicator", () => {
  it("shows the up-to-date status", () => {
    renderAbout(fakeUpdate({ status: "up-to-date" }));
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
  });

  it("shows an error status message", () => {
    renderAbout(fakeUpdate({ status: "error", error: "offline" }));
    expect(screen.getByText("offline")).toBeInTheDocument();
  });
});

describe("AboutSettings update card", () => {
  it("shows the available card with Download + Skip", () => {
    const update = fakeUpdate({
      status: "available",
      updateInfo: { version: "0.0.2", currentVersion: "0.0.1", notes: "Fixes" },
    });
    renderAbout(update);
    expect(screen.getByText("Version 0.0.2")).toBeInTheDocument();
    expect(screen.getByText("Fixes")).toBeInTheDocument();
    screen.getByRole("button", { name: "Download" }).click();
    expect(update.download).toHaveBeenCalledOnce();
    screen.getByRole("button", { name: "Skip" }).click();
    expect(update.skip).toHaveBeenCalledOnce();
  });

  it("shows the download progress bar", () => {
    renderAbout(
      fakeUpdate({
        status: "downloading",
        updateInfo: { version: "0.0.2" },
        progress: { downloaded: 30, total: 100 },
      }),
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
  });

  it("shows Restart to update when ready", () => {
    const update = fakeUpdate({ status: "ready", updateInfo: { version: "0.0.2" } });
    renderAbout(update);
    screen.getByRole("button", { name: "Restart to update" }).click();
    expect(update.restart).toHaveBeenCalledOnce();
  });

  it("hides the card for a skipped version", () => {
    renderAbout(
      fakeUpdate({ status: "available", updateInfo: { version: "0.0.2" }, dismissedVersion: "0.0.2" }),
    );
    expect(screen.queryByText("Update available")).not.toBeInTheDocument();
  });
});

describe("AboutSettings Reset section", () => {
  it("renders the Reset row with the danger-styled button", () => {
    renderAbout(fakeUpdate());
    expect(screen.getByText("Reset all settings")).toBeInTheDocument();
    expect(screen.getByText("Restore every setting to its default value")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Reset to Defaults" });
    expect(button.className).toContain("tx-btn--danger");
  });

  it("arms an inline confirmation; confirming resets everything and re-enables auto-check", () => {
    const store = makeSettingsStore(fakeStorage());
    const resetAll = vi.spyOn(store, "resetAll");
    const update = fakeUpdate();
    store.set("update.checkFrequency", "weekly");
    renderAbout(update, makeFakeOpener(), store);

    fireEvent.click(screen.getByRole("button", { name: "Reset to Defaults" }));
    expect(screen.getByText("Reset everything?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(resetAll).toHaveBeenCalledOnce();
    expect(update.setAutoCheck).toHaveBeenCalledWith(true);
    // The rows reflect the defaults again.
    const select = screen.getByRole("combobox", { name: "Check frequency" }) as HTMLSelectElement;
    expect(select.value).toBe("on-startup");
    // Confirmation disarms back to the resting button.
    expect(screen.getByRole("button", { name: "Reset to Defaults" })).toBeInTheDocument();
  });

  it("cancel disarms without resetting", () => {
    const store = makeSettingsStore(fakeStorage());
    const resetAll = vi.spyOn(store, "resetAll");
    renderAbout(fakeUpdate(), makeFakeOpener(), store);
    fireEvent.click(screen.getByRole("button", { name: "Reset to Defaults" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(resetAll).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reset to Defaults" })).toBeInTheDocument();
  });
});

// trmx-80 (FR-13): the "Open config file" affordance, driven by the hydrated module state
// (getConfigFilePath) — so these tests hydrate with a fake backend, or don't (plain browser).
describe("AboutSettings config file (trmx-80)", () => {
  beforeEach(() => __resetSettingsForTest());
  afterEach(() => __resetSettingsForTest());

  const CONFIG_PATH = "/Users/me/Library/Application Support/termixion/config.toml";

  /** The minimal T2 backend: config_read resolves the path; everything else resolves null. */
  function fakeConfigInvoke(path: string) {
    return (cmd: string): Promise<unknown> => {
      if (cmd === "config_read") {
        return Promise.resolve({
          exists: true,
          path,
          values: { "appearance.theme": "night" },
          warnings: [],
        });
      }
      return Promise.resolve(null);
    };
  }

  it("shows the config path and opens the file through the opener", async () => {
    await hydrateSettings({
      invoke: fakeConfigInvoke(CONFIG_PATH),
      bus: { listen: () => Promise.resolve(() => {}) },
    });
    const opener = renderAbout(fakeUpdate());
    expect(screen.getByText("Open config file")).toBeInTheDocument();
    // The path shows as the row's secondary text so the user can see where the file lives.
    expect(screen.getByText(CONFIG_PATH)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(opener.opened).toEqual([CONFIG_PATH]);
  });

  it("hides the affordance when there is no config path (plain browser)", () => {
    renderAbout(fakeUpdate());
    expect(screen.queryByText("Open config file")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
  });
});
