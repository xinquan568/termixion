// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-145: the ONE native clipboard write sink. Every copy path — the ⌘C/Edit→Copy guard
// (clipboard.ts), auto-copy-on-select (copyOnSelect.ts via TerminalView), and OSC 52 (osc52.ts) —
// writes through this function, which crosses to the clipboard-manager plugin's Rust side over
// Tauri IPC and lands on the pasteboard as a properly constructed NSString.
//
// Why not the webview's own APIs: WKWebView's pasteboard writes (`clipboardData.setData` on a copy
// event, `navigator.clipboard.writeText`) reach OTHER apps with the UTF-8 bytes re-decoded as Mac
// OS Roman — "—" pastes as "‚Äî" (the trmx-145 mojibake). The IPC write bypasses that bridge
// entirely, and needs no user activation (which also retires the documented WKWebView refusal risk
// for OSC 52's gesture-less writes).
//
// Failure tolerance: swallowed, both async and sync — a clipboard set must never surface as a
// terminal error (no Tauri runtime in vitest/browser dev throws synchronously; a refused write
// rejects). Deliberately NO fallback to the webview APIs on failure: a "successful" fallback write
// would re-introduce the very corruption this sink exists to avoid.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Write `text` to the system clipboard through the native (IPC) path; failures are swallowed. */
export function writeClipboardText(text: string): void {
  try {
    void writeText(text).catch(() => {
      // swallowed — refused/failed write is non-fatal (see header)
    });
  } catch {
    // swallowed — a synchronous refusal (no Tauri runtime) is equally non-fatal
  }
}
