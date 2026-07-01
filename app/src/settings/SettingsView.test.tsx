// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the Settings overlay spec — renders only when open, hosts the About page, and closes on
// Escape / backdrop click.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";
import { makeFakeAppInfo } from "../update/appInfo";
import { makeFakeOpener } from "../update/opener";
import type { UseUpdate } from "../update/useUpdate";
import { initialUpdateState } from "../update/updateState";

function fakeUpdate(): UseUpdate {
  return {
    state: initialUpdateState(true),
    checkNow: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    skip: vi.fn(),
    setAutoCheck: vi.fn(),
  };
}

function renderView(open: boolean, onClose = vi.fn()) {
  render(
    <SettingsView
      open={open}
      onClose={onClose}
      update={fakeUpdate()}
      appInfo={makeFakeAppInfo()}
      opener={makeFakeOpener()}
    />,
  );
  return onClose;
}

describe("SettingsView", () => {
  it("renders nothing when closed", () => {
    renderView(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the About page inside a dialog when open", () => {
    renderView(true);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Termixion")).toBeInTheDocument();
  });

  it("closes on the close button, Escape, and a backdrop click", () => {
    // close button
    let onClose = renderView(true);
    screen.getByRole("button", { name: "Close settings" }).click();
    expect(onClose).toHaveBeenCalledOnce();

    // Escape
    onClose = vi.fn();
    render(
      <SettingsView
        open
        onClose={onClose}
        update={fakeUpdate()}
        appInfo={makeFakeAppInfo()}
        opener={makeFakeOpener()}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
