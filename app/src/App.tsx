// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-4: the app shell renders the xterm.js terminal surface. B-5 wires the Tauri command/channel;
// C-2/C-3 stream the live PTY into the terminal.
import { TerminalView } from "./terminal/TerminalView";

export function App() {
  return (
    <main>
      <h1>Termixion</h1>
      <TerminalView />
    </main>
  );
}
