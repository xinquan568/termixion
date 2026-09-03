# Security posture

trmx-252. Three controls and, just as importantly, the limits of each — an undocumented limit reads
as coverage.

## Content-Security-Policy

`crates/termixion-tauri/tauri.conf.json` → `app.security.csp`:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:;
connect-src ipc: http://ipc.localhost; worker-src 'self'
```

`style-src 'unsafe-inline'` is required by Vite's style handling — the grill report (2026-08-26,
assumption A5) predicted exactly this, and the packaged gate below confirmed it.

**`worker-src` is `'self'`, with no `blob:`.** An earlier draft of this work allowed `blob:` on the
stated grounds that xterm's WebGL renderer needs it. **That was wrong**, and review caught it:
`@xterm/addon-webgl@0.18.0` contains no `Worker`, `Blob`, or `createObjectURL` at all, nor does
xterm core, nor does anything in `app/src`. It was a relaxation with no consumer. The directive is
now `'self'`, and the probe asserts a `blob:` worker is **refused** — so the relaxation cannot creep
back without a failing gate. `app/src/smoke/cspPolicy.test.ts` pins it by source.

The directives are pinned separately from the runtime probe because the probe verifies the policy is
ENFORCED and COMPATIBLE, not that it is STRONG: `script-src *` would satisfy every runtime check.

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

Three rules it is built on, each because breaking it produced a real defect in review:

1. **An ambiguous signal is never a verdict.** `TerminalView` falls back to the DOM renderer without
   WebGL2, so "WebGL initialised" cannot separate a CSP block from a headless runner — the renderer
   is *recorded*, never asserted. A failed WebSocket is a CSP failure only when a matching
   `connect-src` violation was recorded; otherwise it is `inconclusive`. And `canary=MISSING` is
   reported alongside `collector=present|ABSENT`, because "the policy let it through" and "the probe
   never loaded" have opposite remedies.
2. **A check that cannot fail proves nothing.** Every relaxation the policy grants is paired with a
   negative probe whose violation *must* appear. An empty violation list on its own is equally
   consistent with a dead listener; the canaries are what make `unexpected=0` mean something.
3. **A positive check must be able to fail independently.** The first draft used one element id and
   one sentinel value for both style checks and never removed the injected `<link>`, so the inline
   check passed off the still-mounted external stylesheet even when inline CSS was blocked — a
   tautology. Each check now owns a distinct id, a distinct sentinel, and removes what it injects.

Passive capture (`app/public/csp-probe.js`, a classic script first in `<head>`) is **diagnostic
only** — Vite prepends `/@vite/client`, so that ordering cannot be won outright, and no assertion
depends on it. Every pass/fail comes from active checks run after the listener is live.

Demonstrated in both directions on the packaged app:

| policy | packaged `--smoke` output | exit |
|---|---|---|
| shipped | `csp=ok renderer=webgl collector=present canaries=img:seen,blob:seen unexpected=0` | 0 |
| `worker-src` **relaxed** to `'self' blob:` | `csp=FAIL … canaries=img:seen,blob:MISSING unexpected=0` | 1 |

Both rows are transcribed from real runs, not predicted.

Note what the second row means: **nothing broke.** `unexpected=0`, the terminal sequence succeeded,
the app was entirely functional — and the gate failed anyway, because the policy got *weaker*. The
inverted canary makes this a check on the policy's strength, not merely on the app's compatibility
with it. A relaxation cannot pass by being harmless.

In a failing run the PTY sequence still succeeds and the smoke fails regardless — a green terminal
does not mask a bad policy.

**Scope of the A5 answer.** The probe exercises the *directives*: a same-origin stylesheet, an
inline style, a same-origin worker, and (in dev) the HMR socket. It does **not** mount React or
instantiate xterm — the smoke path returns before React mounts. So A5 is answered for the policy's
compatibility with those directives, and is **not** a demonstration that the xterm WebGL renderer
itself runs under this CSP. The renderer field in the record is diagnostic only. Mounting the real
terminal composition inside the packaged probe is the obvious next step and is not done here.

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

### Verified at runtime, 2026-09-02

The census and the manifest prove the ACL is *declared*. This is it being *enforced* — captured from
the settings webview of the real packaged app, via a temporary probe reverted before commit:

```
pty_write:               REJECTED: BackendError: pty_write not allowed on window "settings", webview "settings"
open_pty:                REJECTED: BackendError: open_pty not allowed on window "settings", webview "settings"
take_pending_open_paths: REJECTED: BackendError: take_pending_open_paths not allowed on window "settings", webview "settings"
config_read:             RESOLVED (shared command, expected)
themes_read:             RESOLVED (shared command, expected)
```

The exact invocation, from the settings surface of `app/src/main.tsx` after `resolveSurface`:

```ts
await realInvoke("pty_write", { sessionId: 1, data: "x" });
// -> rejects: BackendError: pty_write not allowed on window "settings", webview "settings"
```

The two shared commands resolving is the half that matters as much as the rejections: it shows the
ACL discriminates rather than simply denying everything.

**The handler is not entered.** The evidence is the message's provenance, not an inference about
what else might have failed: the captured string matches the distinctive prefix of the
ACL layer's own format at `tauri-2.11.5/src/ipc/authority.rs:356` (the transcript above elides that
format's trailing URL and diagnostic suffix, so this is a prefix match, not a full one) —
`"{command_pretty_name} not allowed on window \"{window}\", webview \"{webview}\", URL: {}"`.
Capability resolution runs ahead of `run_invoke_handler`, so a denied command never reaches its body.

An earlier draft of this section argued the point differently — that `sessionId: 1` does not exist in
a fresh app, so an entered handler would have failed with the registry's `not_found` `IpcError`
instead. **That reasoning was wrong twice** and is recorded here because the shape of the error is
instructive: `pty_write` takes `data: Vec<u8>` (`pty_io.rs:346`), so the string `"x"` would have
failed serde argument decoding *before* reaching the registry at all; and a normal boot opens a
session, so id 1 is not reliably absent. A counterfactual about a path that could not have been
taken proves nothing.

`take_pending_open_paths` is the one worth noting. Its invariant was already written down
(`main.tsx:85`) and test-pinned (`main.order.test.ts:109` then; executed by `boot.test.tsx` since trmx-250), but both live in the frontend **caller** —
a compromised settings webview bypassed them by invoking the command directly. That line above is
the first time the invariant is enforced somewhere the caller cannot reach.

**Still not covered automatically:** this was a manual run. The `MockRuntime` harness that would
make it a test is issue #245, open and unstarted.

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
