// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-93 (FR-5, test-first): the Scripts page — a "Startup script" Select over the discovered
// scripts ("None" first) that persists scripts.startup through the injected settings store, and an
// "Open scripts folder" button that hits the backend. The scripts catalog + folder action ride an
// injected `invoke` seam so the test drives a fake backend (no Tauri runtime).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScriptsSettings } from "./ScriptsSettings";
import { makeSettingsStore, type KeyValueStore } from "./settingsStore";
import type { InvokeFn } from "../ipc/backend";

function memStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

const SCRIPTS = [
  { relPath: "tools/build.sh", name: "build", sourceLine: "source '/x/tools/build.sh'" },
  { relPath: "work/proj-x.sh", name: "proj-x", sourceLine: "source '/x/work/proj-x.sh'" },
];

function fakeInvoke(): InvokeFn {
  return vi.fn(async (cmd: string) => {
    if (cmd === "scripts_list") return SCRIPTS;
    return undefined;
  }) as unknown as InvokeFn;
}

describe("ScriptsSettings (trmx-93)", () => {
  it("renders the startup Select with None first and the discovered scripts", async () => {
    const settings = makeSettingsStore(memStore());
    render(<ScriptsSettings settings={settings} invoke={fakeInvoke()} />);
    const select = screen.getByLabelText("Startup script") as HTMLSelectElement;
    await waitFor(() => {
      const labels = Array.from(select.options).map((o) => o.value);
      expect(labels).toEqual(["", "tools/build.sh", "work/proj-x.sh"]);
    });
    // "None" is the first option (empty value).
    expect(select.options[0].textContent).toBe("None");
  });

  it("persists the chosen startup script through settings.set", async () => {
    const settings = makeSettingsStore(memStore());
    const setSpy = vi.spyOn(settings, "set");
    render(<ScriptsSettings settings={settings} invoke={fakeInvoke()} />);
    const select = screen.getByLabelText("Startup script") as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: "work/proj-x.sh" } });
    expect(setSpy).toHaveBeenCalledWith("scripts.startup", "work/proj-x.sh");
    expect(settings.get("scripts.startup")).toBe("work/proj-x.sh");
  });

  it("clearing back to None persists the empty value", async () => {
    const settings = makeSettingsStore(memStore());
    settings.set("scripts.startup", "work/proj-x.sh");
    render(<ScriptsSettings settings={settings} invoke={fakeInvoke()} />);
    const select = screen.getByLabelText("Startup script") as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: "" } });
    expect(settings.get("scripts.startup")).toBe("");
  });

  it("Open scripts folder invokes scripts_open_dir", async () => {
    const settings = makeSettingsStore(memStore());
    const invoke = fakeInvoke();
    render(<ScriptsSettings settings={settings} invoke={invoke} />);
    fireEvent.click(screen.getByRole("button", { name: "Open scripts folder" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("scripts_open_dir"));
  });
});
