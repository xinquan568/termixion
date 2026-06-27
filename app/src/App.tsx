// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// A-1 skeleton. B-4 mounts an xterm.js terminal with @xterm/addon-webgl (and the
// Canvas/DOM fallback on WebGL context loss); B-5 wires the Tauri command/channel;
// C-2/C-3 stream the live PTY into the terminal.

export function App() {
  return (
    <main>
      <h1>Termixion</h1>
      <p>Walking skeleton (v0.0.1). The terminal surface arrives in B-4.</p>
    </main>
  );
}
