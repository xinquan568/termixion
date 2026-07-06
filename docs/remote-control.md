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
  (another instance) is left alone, only a stale socket is reclaimed. A user-supplied `socket_path` must
  live in a private (`0700`, you-owned) directory or it is refused.

If you don't want any of this, do nothing — it stays off.

## Enabling it

In `~/.config/termixion/termixion.toml`:

```toml
[remote_control]
enabled = true
# socket_path = ""   # "" = ~/.config/termixion/control.sock (0600 in a 0700 dir)
```

The toggle applies live (the config watcher starts/stops the listener). The default socket is
`~/.config/termixion/control.sock` (or `$XDG_CONFIG_HOME/termixion/control.sock`).

## The `termixion ctl` CLI

The same binary is the client — `termixion ctl <…>` connects, sends one request, prints the JSON response,
and exits `0`/`1` on `ok`:

```sh
# a convenient alias (adjust the path to your install):
alias tmx="/Applications/Termixion.app/Contents/MacOS/termixion ctl"

tmx pane.split-right          # run a registry command by id
tmx ls                        # the tabs/panes tree (see the shape below)
tmx version                   # the app + protocol version
tmx send-text --pane focused "make test\n"   # type into the focused pane's shell
tmx theme.select --arg night  # a command that takes a single string arg
tmx --socket /tmp/tmx.sock ls # target a non-default socket
```

Exit code `0` when the response is `{"ok":true,…}`, `1` otherwise (incl. "cannot connect" when remote
control is disabled).

## The protocol (JSON-lines)

One JSON object per line, request → response. Versioned via `{"cmd":"version"}` (gate your scripts on it).

**Request**: `{ "cmd": "<id>", "args": { … } }`. `cmd` is a command id, `ls`, `version`, or `send-text`.
Unknown top-level fields are ignored; a malformed line returns an error response and the connection stays up.

**Response**: `{ "id": <n>, "ok": <bool>, "result"?: <any>, "error"?: "<reason>" }`.
- A registry command → `{ ok: true }` if it ran, or `{ ok: false, error: "unknown-command" }` (no such id)
  / `{ ok: false, error: "not-applicable" }` (the command's `when` guard refused it, e.g. closing the only
  pane).
- `send-text` → `{ ok: true }`, or `{ ok: false, error: "no-such-pane" }`.
- A request the webview doesn't answer within 2 s → `{ ok: false, error: "timeout" }`.

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
