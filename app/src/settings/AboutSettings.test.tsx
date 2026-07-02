// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the About page spec — identity + version, links both to the GitHub URL, status indicator per
// state, and the update-available card actions. Uses a fake useUpdate + fake appInfo/opener seams.
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AboutSettings } from "./AboutSettings";
import { makeFakeAppInfo } from "../update/appInfo";
import { makeFakeOpener } from "../update/opener";
import type { UseUpdate } from "../update/useUpdate";
import { initialUpdateState, type UpdateState } from "../update/updateState";

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

function renderAbout(update: UseUpdate, opener = makeFakeOpener()) {
  render(<AboutSettings update={update} appInfo={makeFakeAppInfo("0.0.1")} opener={opener} />);
  return opener;
}

describe("AboutSettings", () => {
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

  it("Check now triggers a check and the toggle drives setAutoCheck", () => {
    const update = fakeUpdate();
    renderAbout(update);
    screen.getByRole("button", { name: "Check now" }).click();
    expect(update.checkNow).toHaveBeenCalledOnce();
    screen.getByRole("switch", { name: "Check for updates automatically" }).click();
    expect(update.setAutoCheck).toHaveBeenCalledWith(false);
  });

  it("shows the up-to-date status", () => {
    renderAbout(fakeUpdate({ status: "up-to-date" }));
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
  });

  it("shows an error status message", () => {
    renderAbout(fakeUpdate({ status: "error", error: "offline" }));
    expect(screen.getByText("offline")).toBeInTheDocument();
  });

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
    // The identity + software-update groups render, but no update-available card.
    expect(screen.queryByText("Update available")).not.toBeInTheDocument();
  });
});
