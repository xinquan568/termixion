// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-4/B-5: the app shell. On load it handshakes with the backend (core_version round-trip + PTY
// channel setup via useBackend) and renders the xterm.js terminal surface. C-2/C-3 stream the live
// PTY into the terminal.
//
// trmx-35: the terminal owns the whole window — no in-page chrome (program name / core version) and
// no padding/margins, flush to every edge like iTerm2 / Kitty (see index.css). The backend handshake
// still runs inside useBackend (console log + readiness); we just don't render its result.
// trmx-48: the SettingsHost mounts alongside the terminal — it renders nothing until the native menu
// ("About Termixion" / "Settings…") opens the Settings → About overlay above the terminal.
import { TerminalView } from "./terminal/TerminalView";
import { useBackend } from "./ipc/useBackend";
import { SettingsHost } from "./settings/SettingsHost";

export function App() {
  const { attachTerminal } = useBackend();
  return (
    <main className="app">
      <TerminalView onReady={attachTerminal} />
      <SettingsHost />
    </main>
  );
}
