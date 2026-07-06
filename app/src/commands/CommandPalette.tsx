// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94 (FR-9.2): the ⇧⌘P command palette — fuzzy, keyboard-first access to every command over the
// generic PaletteOverlay chassis. The main page lists the visible commands (when-false hidden),
// recent-first (session MRU) then in registry (category) order, each showing its current binding as a
// right-aligned hint; fuzzy matches title+id+category. A parameterized command (theme.select /
// script.run) drills into a SECOND PaletteOverlay page (themes / scripts) — two levels max. Enter
// runs (through `dispatch`, the single spine); Esc backs out of a param page, else closes.
import { useEffect, useState } from "react";
import { realInvoke, type InvokeFn } from "../ipc/backend";
import { PaletteOverlay } from "./PaletteOverlay";
import type { Command, CommandContext } from "./registry";
import { listScripts, type ScriptEntry } from "../scripts/scriptsBackend";

/** A theme entry the palette's `theme.select` page lists (id + label; from the trmx-89 registry). */
export interface PaletteTheme {
  id: string;
  title: string;
}

/** The current binding (canonical chord) for a command id, or undefined — the palette's right hint.
 * Pure: reverse-looks-up the effective keymap (first chord that maps to the id, deterministic order). */
export function bindingFor(id: string, keymap: Record<string, string>): string | undefined {
  for (const [chord, command] of Object.entries(keymap)) {
    if (command === id) return chord;
  }
  return undefined;
}

/** The main-page command order: visible (when-true) commands, recent-first (MRU) then registry order.
 * Pure + unit-tested. */
export function orderedCommands(commands: Command[], recent: string[], ctx: CommandContext): Command[] {
  const visible = commands.filter((c) => !c.when || c.when(ctx));
  const byId = new Map(visible.map((c) => [c.id, c]));
  const recentVisible = recent
    .map((id) => byId.get(id))
    .filter((c): c is Command => c !== undefined);
  const recentIds = new Set(recentVisible.map((c) => c.id));
  const rest = visible.filter((c) => !recentIds.has(c.id));
  return [...recentVisible, ...rest];
}

export interface CommandPaletteProps {
  commands: Command[];
  dispatch: (id: string, arg?: string) => void;
  recentCommandIds: string[];
  ctx: CommandContext;
  /** The effective keymap (defaults ⊕ user), for the binding hints. */
  keymap: Record<string, string>;
  /** Themes for the `theme.select` page (from the theme registry). */
  themes: PaletteTheme[];
  /** Backend edge for the `script.run` page's `listScripts`; injected for tests. */
  invoke?: InvokeFn;
  onClose: () => void;
}

type Page = { kind: "commands" } | { kind: "param"; command: Command };

export function CommandPalette({
  commands,
  dispatch,
  recentCommandIds,
  ctx,
  keymap,
  themes,
  invoke = realInvoke,
  onClose,
}: CommandPaletteProps) {
  const [page, setPage] = useState<Page>({ kind: "commands" });
  const [scripts, setScripts] = useState<ScriptEntry[]>([]);

  // Load scripts lazily when the script.run page opens (mirrors ScriptPicker; inert without a runtime).
  useEffect(() => {
    if (page.kind !== "param" || page.command.param !== "script") return;
    let live = true;
    listScripts(invoke).then((entries) => {
      if (live) setScripts(entries);
    });
    return () => {
      live = false;
    };
  }, [page, invoke]);

  if (page.kind === "commands") {
    const ordered = orderedCommands(commands, recentCommandIds, ctx);
    return (
      <PaletteOverlay
        key="palette-commands"
        items={ordered}
        filterKey={(c) => `${c.title} ${c.id} ${c.category}`}
        itemKey={(c) => c.id}
        renderItem={(c) => (
          <>
            <span className="tx-command-palette__title">{c.title}</span>
            <span className="tx-command-palette__category">{c.category}</span>
            <span className="tx-command-palette__hint">{bindingFor(c.id, keymap) ?? ""}</span>
          </>
        )}
        onRun={(c) => {
          if (c.param) {
            setPage({ kind: "param", command: c });
          } else {
            dispatch(c.id);
            onClose();
          }
        }}
        onCancel={onClose}
        placeholder="Run a command…"
        dialogLabel="Command palette"
        inputAriaLabel="Filter commands"
        listAriaLabel="Commands"
        emptyText="No matching command"
        testId="command-palette"
        classPrefix="tx-command-palette"
      />
    );
  }

  // A parameterized second page: themes (sync) or scripts (loaded above).
  const backOrClose = () => setPage({ kind: "commands" });
  if (page.command.param === "theme") {
    return (
      <PaletteOverlay
        key={`palette-theme-${page.command.id}`}
        items={themes}
        filterKey={(t) => `${t.title} ${t.id}`}
        itemKey={(t) => t.id}
        renderItem={(t) => <span className="tx-command-palette__title">{t.title}</span>}
        onRun={(t) => {
          dispatch(page.command.id, t.id);
          onClose();
        }}
        onCancel={backOrClose}
        placeholder="Change theme…"
        dialogLabel="Change theme"
        inputAriaLabel="Filter themes"
        listAriaLabel="Themes"
        emptyText="No matching theme"
        testId="command-palette-param"
        classPrefix="tx-command-palette"
      />
    );
  }
  return (
    <PaletteOverlay
      key={`palette-script-${page.command.id}`}
      items={scripts}
      filterKey={(s) => s.relPath}
      itemKey={(s) => s.relPath}
      renderItem={(s) => (
        <>
          <span className="tx-command-palette__title">{s.name}</span>
          <span className="tx-command-palette__category">{s.relPath}</span>
        </>
      )}
      onRun={(s) => {
        dispatch(page.command.id, s.sourceLine);
        onClose();
      }}
      onCancel={backOrClose}
      placeholder="Run a script…"
      dialogLabel="Run a script"
      inputAriaLabel="Filter scripts"
      listAriaLabel="Scripts"
      emptyText="No scripts — add files to ~/.config/termixion/scripts/"
      testId="command-palette-param"
      classPrefix="tx-command-palette"
    />
  );
}
