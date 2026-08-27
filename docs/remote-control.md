# Remote control — the external scriptable control channel (trmx-101, FR-9.4)

Termixion can expose an **opt-in local socket** through which scripts drive the running terminal — every
command in the [command reference](commands.md) by id, plus a few queries and a `send-text` primitive. It
is modeled on Kitty's `kitty @`. **It is OFF by default.**

## Security posture (read this first)

A terminal's remote-control surface is an **arbitrary-code-execution surface by design**: `send-text` types
into your shell, and any command that runs a script does so as you. Termixion treats that honestly:

- **Off by default.** Nothing listens until you set `remote_control.enabled = true`.
- **Local, same-user only.** A **unix-domain socket** — there is **NO TCP listener, ever**. The socket file
  is `0600` inside a `0700` directory owned by your user. The threat model is: anyone who already has your
  uid can already run commands as you; the permissions defend against *other* local users and sandboxed
  apps, not against yourself.
- **A live second instance is never clobbered.** On start Termixion probes an existing socket; a live one
  (another instance) is left alone, only a stale socket is reclaimed. A user-supplied `socket_path` must be
  an **absolute** path whose parent **already exists** as a real directory you own with mode **exactly
  `0700`** — otherwise it is refused; Termixion never creates or chmod-s that parent for you (trmx-235). The
  default path's own `control/` subdir *is* created-or-tightened to `0700`.
- **Bounded.** At most 16 concurrent connections (the rest get `too-many-connections`), at most 64 KiB per
  request line (`line-too-long`), strict UTF-8 (`invalid-utf8` — a malformed line is never dispatched). A
  listener whose acceptor hits a fatal error is restarted on the next config apply (toggle
  `remote_control.enabled`, or any settings write).

If you don't want any of this, do nothing — it stays off.

## Enabling it

In `~/.config/termixion/termixion.toml`:

```toml
[remote_control]
enabled = true
# socket_path = ""   # "" = ~/.config/termixion/control/control.sock (0600 in a 0700 dir)
```

The toggle applies live (the config watcher starts/stops the listener). The default socket is
`~/.config/termixion/control/control.sock` (or `$XDG_CONFIG_HOME/termixion/control/control.sock`) — a
dedicated `control/` subdir so its parent can be private without touching the rest of the config tree.

## The `termixion ctl` CLI

The same binary is the client — `termixion ctl <…>` connects, sends one request, prints the JSON response,
and exits `0`/`1` on `ok`:

```sh
# a convenient alias (adjust the path to your install):
alias tmx="/Applications/Termixion.app/Contents/MacOS/termixion ctl"

tmx pane.split-right          # run a registry command by id
tmx ls                        # the tabs/panes tree (see the shape below)
tmx version                   # the app + protocol version
tmx commands                  # the protocol version + every callable command id (gate scripts on it)
tmx send-text --pane focused "make test\n"   # type into the focused pane's shell
tmx theme.select --arg night  # a command that takes a single string arg
tmx --socket /tmp/tmx.sock ls # target a non-default socket
```

Exit code `0` when the response is `{"ok":true,…}`, `1` otherwise (incl. "cannot connect" when remote
control is disabled). Output is UTF-8 (a title such as `vim — main.rs` prints intact — trmx-235). The client
waits up to 10 s for the response — longer than the server's own 8 s request timeout, so a `timeout` reply
is always printed rather than "no response".

## The protocol (JSON-lines)

One JSON object per line, request → response. Versioned via `{"cmd":"version"}` (gate your scripts on it).

**Request**: `{ "cmd": "<id>", "args": { … } }`. `cmd` is a command id, `ls`, `version`, `commands`, or
`send-text`. Unknown top-level fields are ignored; malformed JSON returns an error response and the
connection stays up. The transport itself is bounded (trmx-235): a request line over 64 KiB is answered
`{ "id": 0, "ok": false, "error": "line-too-long" }` and the connection closes; a line that is not valid
UTF-8 is answered `invalid-utf8` and closed (it is never dispatched); beyond 16 concurrent connections the
server answers `too-many-connections` (or `spawn-failed` if the OS refuses a thread) and closes.

**Response**: `{ "id": <n>, "ok": <bool>, "result"?: <any>, "error"?: "<reason>" }`.
- A registry command → `{ ok: true }` if it ran, or `{ ok: false, error: "unknown-command" }` (no such id)
  / `{ ok: false, error: "not-applicable" }` (the command's `when` guard refused it, e.g. closing the only
  pane).
- `send-text` → `{ ok: true }`, or `{ ok: false, error: "no-such-pane" }`.
- `commands` → `{ ok: true, result: { protocol: 1, commands: ["app.check-updates", …] } }` — every id that is
  callable over the socket (trmx-235). Older servers answer it with `unknown-command`.
- A request the webview doesn't answer within **8 s** → `{ ok: false, error: "timeout" }`. **After a
  `timeout` the command's fate is unknown**: it may already have run, may still run late, or may never be
  handled. Retrying a mutating command (`pane.split-right`, `send-text`, …) can therefore execute it twice;
  query with `ls` before retrying. A late reply is logged by the app.

### The callable command set is part of the protocol

Every id in the [command reference](commands.md) is callable. That set is pinned, per protocol version, by
`app/src/control/__fixtures__/control-commands.json` — **any** change to it (adding, removing, or renaming an
id) is a protocol change: `protocol` in that file, `CONTROL_PROTOCOL_VERSION` (`controlBridge.ts`), and
`PROTOCOL_VERSION` (`control_io.rs`) bump together, and CI's `scripts/check-control-protocol.sh` refuses a
change that doesn't. Gate scripts on `version` / `commands` and they will see the bump.

**Close commands never prompt.** `pane.close`, `tab.close`, and `window.close` over the socket bypass the
[`terminal.confirm_close`](config.md) confirmation entirely — no dialog in **any** mode, including
`always` (trmx-144). A scripted close is explicit intent and must stay non-interactive.

### `ls` — the tabs/panes snapshot (a stable, versioned shape)

```json
{
  "protocol": 1,
  "tabs": [
    {
      "id": 10,
      "active": true,
      "panes": [
        { "id": 1, "sessionId": 100, "title": "zsh", "cwd": "/home", "busy": false, "focused": false },
        { "id": 2, "sessionId": 101, "title": "vim", "cwd": null,   "busy": true,  "focused": true  }
      ]
    }
  ]
}
```

`panes` are in the tree's leaf order. `cwd` is the last OSC 7 report (null if none). `busy` is the activity
state (accurate with the [OSC 133 shell integration](activity-indicator.md) installed). The shape is pinned
by a golden fixture — a change to it is a conscious protocol change.

### `send-text`

`{ "cmd": "send-text", "args": { "pane": "<paneId|focused>", "text": "…" } }` writes `text` verbatim (incl.
newlines) to that pane's PTY — the automation primitive. **This types into your shell**; treat it as running
a command as you.

## How it works (design)

The socket + its permissions live entirely in the Rust shell (`termixion-tauri`), never in the
platform-agnostic core. A dedicated acceptor thread bridges each request to the webview (`control:request`),
which dispatches it through the **same command path as a keypress** (no second implementation) and replies;
queries build a snapshot from the live UI state. Non-GUI `termixion ctl` is an early argv fork that never
starts the app.
