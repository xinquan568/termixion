// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
//! trmx-101 (FR-9.4): the PURE protocol codec + `ctl` argv mapper for the external control channel. No
//! Tauri, no socket, no I/O — just parse a JSON-lines request line into a `Request`, serialize a
//! `Response`, and map `termixion ctl <…>` argv into a request line. The socket edge (`control.rs`) is a
//! thin shell around these; keeping the codec pure makes it headless-unit-testable (the `smoke_mode` style).

use serde::Serialize;
use serde_json::{Value as JsonValue, json};

/// The protocol version consumers gate on (`{"cmd":"version"}` returns it). Bump on a breaking change.
pub const PROTOCOL_VERSION: u32 = 1;

/// A parsed control request. Read-only queries (`Ls`/`Version`) have no registry side effect; `Command`
/// dispatches through the trmx-94 registry; `SendText` types into a pane's PTY.
#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    /// A trmx-94 registry command by id, with an optional single-string arg (theme id / script path).
    Command { cmd: String, arg: Option<String> },
    /// The tabs/panes tree snapshot (built frontend-side).
    Ls,
    /// The app + protocol version (answered shell-side).
    Version,
    /// Type text into a pane's PTY. `pane` is a pane id or the literal `"focused"`.
    SendText { pane: String, text: String },
}

/// Parse one JSON-lines request line. Unknown top-level fields are ignored; a missing/blank `cmd`, or
/// malformed JSON, is an `Err` (the caller emits an error response and keeps the connection up).
pub fn parse_request(line: &str) -> Result<Request, String> {
    let v: JsonValue =
        serde_json::from_str(line.trim()).map_err(|e| format!("invalid json: {e}"))?;
    let cmd = v
        .get("cmd")
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "missing 'cmd'".to_string())?;
    match cmd {
        "ls" => Ok(Request::Ls),
        "version" => Ok(Request::Version),
        "send-text" => {
            let args = v
                .get("args")
                .ok_or_else(|| "send-text requires 'args'".to_string())?;
            let pane = args
                .get("pane")
                .and_then(|p| p.as_str())
                .unwrap_or("focused")
                .to_string();
            let text = args
                .get("text")
                .and_then(|t| t.as_str())
                .ok_or_else(|| "send-text requires 'args.text'".to_string())?
                .to_string();
            Ok(Request::SendText { pane, text })
        }
        other => {
            // A registry command; accept an optional single string arg at args.arg.
            let arg = v
                .get("args")
                .and_then(|a| a.get("arg"))
                .and_then(|a| a.as_str())
                .map(|s| s.to_string());
            Ok(Request::Command {
                cmd: other.to_string(),
                arg,
            })
        }
    }
}

/// A response for one request. `result` carries a query's data (ls/version); `error` is the failure
/// reason. Serialized as ONE `\n`-terminated JSON line.
#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok(id: u64, result: Option<JsonValue>) -> Self {
        Self {
            id,
            ok: true,
            result,
            error: None,
        }
    }
    pub fn err(id: u64, error: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(error.into()),
        }
    }
}

/// One `\n`-terminated JSON line for a response.
pub fn serialize_response(r: &Response) -> String {
    let body = serde_json::to_string(r)
        .unwrap_or_else(|_| r#"{"ok":false,"error":"serialize"}"#.to_string());
    format!("{body}\n")
}

/// A `ctl` invocation resolved to (an optional socket override) + the JSON request line to send.
#[derive(Debug, Clone, PartialEq)]
pub struct CtlRequest {
    pub socket: Option<String>,
    pub request_line: String,
}

/// Map `termixion ctl [--socket PATH] <cmd> [args…]` argv into a request line. Shorthand:
/// `ctl pane.split-right`, `ctl ls`, `ctl send-text --pane focused "make test\n"`,
/// `ctl theme.select --arg night`. `args` is the FULL argv (incl. argv[0] + the `ctl` token).
pub fn parse_ctl_argv<I: IntoIterator<Item = String>>(args: I) -> Result<CtlRequest, String> {
    let mut it = args.into_iter();
    it.next(); // argv[0] — the program name
    match it.next().as_deref() {
        Some("ctl") => {}
        _ => return Err("expected the `ctl` subcommand".to_string()),
    }
    let mut rest: Vec<String> = it.collect();

    // Optional leading `--socket PATH`.
    let mut socket = None;
    if rest.first().map(String::as_str) == Some("--socket") {
        rest.remove(0);
        if rest.is_empty() {
            return Err("--socket requires a PATH".to_string());
        }
        socket = Some(rest.remove(0));
    }

    let cmd = if rest.is_empty() {
        return Err("expected a command, e.g. `ctl ls`".to_string());
    } else {
        rest.remove(0)
    };

    let request_line = match cmd.as_str() {
        "ls" | "version" => json!({ "cmd": cmd }).to_string(),
        "send-text" => {
            let mut pane = "focused".to_string();
            let mut text: Option<String> = None;
            let mut i = 0;
            while i < rest.len() {
                match rest[i].as_str() {
                    "--pane" => {
                        pane = rest.get(i + 1).cloned().ok_or("--pane requires a value")?;
                        i += 2;
                    }
                    "--text" => {
                        text = Some(rest.get(i + 1).cloned().ok_or("--text requires a value")?);
                        i += 2;
                    }
                    _ => {
                        text = Some(rest[i].clone()); // a positional text argument
                        i += 1;
                    }
                }
            }
            let text = text.ok_or("send-text requires text")?;
            json!({ "cmd": "send-text", "args": { "pane": pane, "text": text } }).to_string()
        }
        _ => {
            // A registry command; optional `--arg VALUE`.
            let mut arg: Option<String> = None;
            let mut i = 0;
            while i < rest.len() {
                if rest[i] == "--arg" {
                    arg = Some(rest.get(i + 1).cloned().ok_or("--arg requires a value")?);
                    i += 2;
                } else {
                    return Err(format!("unexpected argument '{}'", rest[i]));
                }
            }
            match arg {
                Some(a) => json!({ "cmd": cmd, "args": { "arg": a } }).to_string(),
                None => json!({ "cmd": cmd }).to_string(),
            }
        }
    };
    Ok(CtlRequest {
        socket,
        request_line,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        std::iter::once("termixion".to_string())
            .chain(parts.iter().map(|s| s.to_string()))
            .collect()
    }

    #[test]
    fn parses_a_registry_command_with_and_without_arg() {
        assert_eq!(
            parse_request(r#"{"cmd":"pane.split-right"}"#).unwrap(),
            Request::Command {
                cmd: "pane.split-right".to_string(),
                arg: None
            }
        );
        assert_eq!(
            parse_request(r#"{"cmd":"theme.select","args":{"arg":"night"}}"#).unwrap(),
            Request::Command {
                cmd: "theme.select".to_string(),
                arg: Some("night".to_string())
            }
        );
    }

    #[test]
    fn parses_queries_and_send_text() {
        assert_eq!(parse_request(r#"{"cmd":"ls"}"#).unwrap(), Request::Ls);
        assert_eq!(
            parse_request(r#"{"cmd":"version"}"#).unwrap(),
            Request::Version
        );
        assert_eq!(
            parse_request(r#"{"cmd":"send-text","args":{"pane":"3","text":"make\n"}}"#).unwrap(),
            Request::SendText {
                pane: "3".to_string(),
                text: "make\n".to_string()
            }
        );
        // pane defaults to focused
        assert_eq!(
            parse_request(r#"{"cmd":"send-text","args":{"text":"hi"}}"#).unwrap(),
            Request::SendText {
                pane: "focused".to_string(),
                text: "hi".to_string()
            }
        );
    }

    #[test]
    fn ignores_unknown_fields_but_rejects_malformed_and_missing_cmd() {
        assert!(parse_request(r#"{"cmd":"ls","extra":42}"#).is_ok()); // unknown field ignored
        assert!(parse_request("not json").is_err());
        assert!(parse_request(r#"{"nope":1}"#).is_err()); // missing cmd
        assert!(parse_request(r#"{"cmd":""}"#).is_err()); // blank cmd
        assert!(parse_request(r#"{"cmd":"send-text"}"#).is_err()); // send-text without args
    }

    #[test]
    fn serialize_response_is_one_terminated_line() {
        let s = serialize_response(&Response::ok(7, Some(json!({"v":1}))));
        assert!(s.ends_with('\n'));
        assert_eq!(s.matches('\n').count(), 1);
        assert!(s.contains(r#""id":7"#) && s.contains(r#""ok":true"#));
        let e = serialize_response(&Response::err(7, "unknown-command"));
        assert!(e.contains(r#""ok":false"#) && e.contains("unknown-command"));
        assert!(!e.contains(r#""result""#)); // omitted when None
    }

    #[test]
    fn ctl_argv_maps_shorthands() {
        assert_eq!(
            parse_ctl_argv(argv(&["ctl", "pane.split-right"]))
                .unwrap()
                .request_line,
            r#"{"cmd":"pane.split-right"}"#
        );
        assert_eq!(
            parse_ctl_argv(argv(&["ctl", "ls"])).unwrap().request_line,
            r#"{"cmd":"ls"}"#
        );
        let t = parse_ctl_argv(argv(&[
            "ctl",
            "send-text",
            "--pane",
            "focused",
            "make test\n",
        ]))
        .unwrap();
        assert!(t.request_line.contains(r#""cmd":"send-text""#));
        assert!(t.request_line.contains(r#""pane":"focused""#));
        assert!(t.request_line.contains("make test"));
        let th = parse_ctl_argv(argv(&["ctl", "theme.select", "--arg", "night"])).unwrap();
        assert!(th.request_line.contains(r#""arg":"night""#));
    }

    #[test]
    fn ctl_argv_handles_socket_override_and_errors() {
        let r = parse_ctl_argv(argv(&["ctl", "--socket", "/tmp/x.sock", "ls"])).unwrap();
        assert_eq!(r.socket.as_deref(), Some("/tmp/x.sock"));
        assert!(parse_ctl_argv(argv(&["ctl"])).is_err()); // no command
        assert!(parse_ctl_argv(argv(&["ctl", "--socket"])).is_err()); // dangling --socket
        assert!(parse_ctl_argv(argv(&["not-ctl", "ls"])).is_err()); // wrong subcommand
        assert!(parse_ctl_argv(argv(&["ctl", "send-text", "--pane", "focused"])).is_err()); // no text
    }
}
