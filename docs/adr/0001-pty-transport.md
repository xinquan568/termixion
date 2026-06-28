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
output stream (only) to a local WebSocket and re-measure. Record that as ADR-0002.
