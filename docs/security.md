# Security posture

trmx-252. Three controls and, just as importantly, the limits of each — an undocumented limit reads
as coverage.

## Content-Security-Policy

`crates/termixion-tauri/tauri.conf.json` → `app.security.csp`:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:;
connect-src ipc: http://ipc.localhost; worker-src 'self' blob:
```

`worker-src 'self' blob:` is load-bearing: xterm's WebGL renderer constructs a `blob:` worker, and
dropping it breaks the terminal. `style-src 'unsafe-inline'` is required by Vite's style handling —
the grill report (2026-08-26, assumption A5) predicted this, and the gate below confirmed it.

### `devCsp` does NOT apply on desktop

`app.security.devCsp` is set, and on desktop it **has no effect**. This is not a Termixion bug:

```rust
// tauri-2.11.5/src/manager/webview.rs:43
pub(crate) const PROXY_DEV_SERVER: bool = cfg!(all(dev, mobile));
```

`PROXY_DEV_SERVER` is true only on **mobile**. On desktop, `cargo tauri dev` points the webview at
the external `devUrl` (`http://localhost:5173`), so the document is served by Vite and never passes
through Tauri's asset protocol — `inject_csp` / `replace_csp_nonce` never run.
`AppManager::csp()` does select `dev_csp` in dev (`manager/mod.rs:370`), but nothing applies it to
an externally-served document.

Measured, not inferred: a `cargo tauri dev` smoke run reports
`collector=present canary=MISSING` — the violation listener was live, and a cross-origin image that
`img-src 'self' data: blob:` must block produced **no violation**.

**So: development builds run with no CSP.** The key is kept because it is correct if Tauri ever
applies it, and because `tauri.conf.json` is JSON and cannot carry a comment saying so — this
section is that comment. Termixion is macOS-only (trmx-187), so the mobile path never applies.

**Playwright likewise exercises no CSP.** `app/playwright.config.ts` drives the raw Vite server
(`baseURL: http://localhost:5173`, `webServer: pnpm dev`), never a Tauri window. A green e2e run is
not CSP evidence.

## The CSP gate

`app/src/smoke/cspProbe.ts`, riding the packaged `--smoke` (`scripts/smoke.sh`). It runs in the real
webview under the real policy — the only path that does.

Two rules it is built on:

1. **An ambiguous signal is never a verdict.** `TerminalView` falls back to the DOM renderer without
   WebGL2, so "WebGL initialised" cannot separate a CSP block from a headless runner — the renderer
   is *recorded*, never asserted. A failed WebSocket is a CSP failure only when a matching
   `connect-src` violation was recorded; otherwise it is `inconclusive`. And `canary=MISSING` is
   reported alongside `collector=present|ABSENT`, because "the policy let it through" and "the probe
   never loaded" have opposite remedies.
2. **A check that cannot fail proves nothing.** The canary is a deliberately blocked request whose
   violation *must* appear. An empty violation list on its own is equally consistent with a dead
   listener; the canary is what makes `unexpected=0` mean something.

Passive capture (`app/public/csp-probe.js`, a classic script first in `<head>`) is **diagnostic
only** — Vite prepends `/@vite/client`, so that ordering cannot be won outright, and no assertion
depends on it. Every pass/fail comes from active checks run after the listener is live.

Demonstrated in both directions on the packaged app:

| policy | result | exit |
|---|---|---|
| `worker-src 'self' blob:` | `csp=ok renderer=webgl unexpected=0 canary=seen` | 0 |
| `worker-src 'self'` (hostile) | `csp=FAIL unexpected=1 canary=seen failed[workerBlob=fail] violation[worker-src blob]` | 1 |

In the failing run the PTY sequence still succeeded, and the smoke failed anyway — a green terminal
does not mask a broken policy.

## Per-window command capabilities

`build.rs` declares `AppManifest::commands` over all 33 registered commands, so Tauri applies a
per-window ACL. Without it every command is callable from every window.

**14 main-only** — `open_pty`, `pty_write`, `pty_ack`, `pty_resize`, `close_pty`, `control_response`,
`quit_confirmed`, `webview_close_request`, `close_acknowledged`, `take_pending_open_paths`,
`smoke_config`, `smoke_done`, `perf_config`, `perf_done`.

**19 shared** with the settings window — the config/theme/script/log/shell readers and writers.

`crates/termixion-tauri/tests/command_capabilities.rs` parses both `main.rs`'s `invoke_handler` list
and `build.rs`'s manifest with `syn` and fails on drift in either direction, and asserts the two
named sets against the capability files. The list is never transcribed: it drifted from 28 to 33
across three unrelated workstreams in one week (trmx-236, trmx-238, trmx-268, minus trmx-243's
removal), which is precisely why a hand-maintained list is not viable.

Omission fails **closed** — a command missing from the manifest is denied, so the risk is an
availability regression rather than a silent hole.

**Not covered automatically:** runtime capability *rejection* from the settings window. The
`MockRuntime` harness is issue #245. Until then this is a documented manual check.

## OSC 52 clipboard writes

`terminal.clipboard_write` = `allow` | `deny` (default `allow`). See `docs/config.md`.

The policy is read **at write time** through a thunk, never captured at attach time — the handler is
attached once per terminal, so a captured value would ignore every later change.

On `deny` the sequence is still **consumed**, matching the existing stance for queries and oversized
payloads, so nothing falls through to another handler.

The notice says the write request was **accepted**, not that the clipboard changed: the native write
goes over IPC and swallows async failure, so the code cannot observe the outcome. Claiming otherwise
would assert something unverifiable.

Reads remain impossible: an OSC 52 query (`Pd === "?"`) is consumed and never answered, so a remote
program can never exfiltrate the clipboard.
