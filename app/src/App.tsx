// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-4/B-5: the app shell. On load it handshakes with the backend (core_version round-trip + PTY
// channel setup via useBackend) and renders the xterm.js terminal surface. C-2/C-3 stream the live
// PTY into the terminal.
import { TerminalView } from "./terminal/TerminalView";
import { useBackend } from "./ipc/useBackend";

export function App() {
  const { coreVersion, attachTerminal } = useBackend();
  return (
    <main>
      <h1>Termixion</h1>
      <p className="status" data-testid="core-version">
        {coreVersion ? `core v${coreVersion}` : "connecting…"}
      </p>
      <TerminalView onReady={attachTerminal} />
    </main>
  );
}
