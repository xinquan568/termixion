# ADR-0001 — PTY ↔ webview transport

- Status: accepted (C-2, v0.0.1)
- Context: S2 (the plan's transport decision)

## Decision

Stream PTY bytes between the Rust shell and the xterm.js webview over **Tauri's IPC `Channel`**
(`tauri::ipc::Channel<Vec<u8>>` backend → `@tauri-apps/api/core` `Channel` frontend), with keystrokes
sent back via a plain `invoke("pty_write", …)` command. This is the seam already established in B-5.

A **local WebSocket** transport is the documented fallback — to be adopted **only if** a measured
throughput/latency problem appears against the §8 NFR-1 target on the reference Mac (Q-g, M1 Pro). It is
**not** built for v0.0.1.

## Why

- **Tauri Channel** is the native, zero-extra-dependency path: ordered, typed, no port/origin/auth to
  manage, and lifecycle-bound to the window. PTY output is bursty but modest for an interactive shell,
  well within IPC's envelope for v0.0.1.
- A **WebSocket** would add a local server, a port, and an auth/origin story for no benefit until/unless
  throughput is actually the bottleneck — premature for the walking skeleton.

## Shape

- **Output (PTY → webview):** the backend spawns the session, **splits off the blocking read half**
  (`Session::take_reader()` — the core `PtyReader` seam, C-2) onto a dedicated thread that reads and
  `channel.send(bytes)`s. Splitting the reader off is what lets reads block on their own thread while
  writes/resizes happen concurrently from command handlers.
- **Input (webview → PTY):** xterm `onData` → `invoke("pty_write", { data })` → `session.write(bytes)`.
- **Resize:** xterm `onResize` → `invoke("pty_resize", { rows, cols })` → `session.resize(...)`.
- **Teardown:** the session lives in Tauri-managed state; window close / app exit kills it (C-3),
  reaping the child (no zombie).

## Revisit if

PTY output throughput or keystroke latency misses NFR-1 on the M1 Pro reference machine — then move the
output stream (only) to a local WebSocket and re-measure. Record that as a future ADR (0002 is taken by the no-chezmoi decision, trmx-208).

## Addendum (trmx-241, 2026-08-28): PTY frames are raw bytes, not JSON

"Revisit if throughput misses NFR-1" above named the trigger; the 2026-08-26 review found the
encoding underneath the transport was the first thing to saturate, so this is the revisit — of the
**encoding**, not the transport. The channel stays.

**What changed.** `open_pty` streamed through `Channel<Vec<u8>>`, which Tauri serializes as JSON: a
256 KiB batch became `[27,91,48,…]` (~3.5x inflation for typical terminal output), was `JSON.parse`d
into a `number[]` of boxed 8-byte elements, then copied again by `Uint8Array.from`. It now sends
`tauri::ipc::Response::new(batch)` — a raw body — and the frontend takes a `Uint8Array` **view** over
the delivered `ArrayBuffer`. Batching, credits, acks and the overdraw floor are untouched: the same
bytes, counted the same way, framed differently.

**The delivery contract, verified rather than assumed.** Static reading established this only for
Tauri's *custom-protocol* route: `ipc/protocol.rs:392-405` routes a raw body through `format_result`
— a JSON number array — when `cfg!(target_os = "macos")` and the custom protocol is unavailable, and
Termixion is macOS-only. A packaged spike settled it. Three frames (64 B → **256 KiB** → 64 B,
sentinel-tagged) deliberately straddle Tauri's `MAX_RAW_DIRECT_EXECUTE_THRESHOLD = 1024`, so they
cross both internal paths — `eval` below it, `fetch` above:

```
TRMX241-SPIKE 0:[object ArrayBuffer] len=64     first=0x11 last=0x19
TRMX241-SPIKE 1:[object ArrayBuffer] len=262144 first=0x22 last=0x29
TRMX241-SPIKE 2:[object ArrayBuffer] len=64     first=0x33 last=0x39
```

Type, byte length, sentinel integrity and **arrival order across the eval/fetch boundary** all held.
Ordering mattered: a reordering here would corrupt the byte stream silently rather than loudly.

The frontend decode brand-checks with `Object.prototype.toString` (cross-realm safe, unlike
`instanceof`) and **throws** on a `number[]` rather than accepting it. That is deliberate: TypeScript
types are erased and `new Uint8Array([104,105])` is legal at runtime, so a permissive decode would
keep working if Tauri ever fell back to the JSON path — turning a transport regression into an
unexplained slowdown instead of a failure.

**Throughput: NOT YET MEASURED — outstanding.** `scripts/perf.sh` needs the packaged app frontmost
with the display awake, and the automated environment this change was made in could not hold that:
one baseline run completed (release, webgl, `scrollYes` 9.26% dropped — itself over the <5% budget
for the same reason), and every subsequent run — candidate *and* baseline, with and without
`caffeinate` — timed out at "waiting for the webview perf driver". No decode error appeared in any
log, so the timeouts are the harness's environment requirement, not this change.

**So the encoding win is argued and structurally verified, but not yet quantified.** Before treating
NFR-1 as re-answered, run on the reference machine, attended:

```
(cd crates/termixion-tauri && cargo tauri build)
bash scripts/perf.sh          # baseline: rebuild from ccb7916 for the before-number
```

and record the delta here.
