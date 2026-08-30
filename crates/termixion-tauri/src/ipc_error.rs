// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-249: the typed error shape every fallible `#[tauri::command]` rejects with.
//!
//! Before this, each of the 15 fallible commands rejected with a bare `String`, so the frontend
//! could only pattern-match on message text — and `String(err)` on a non-`Error` value renders
//! `[object Object]` the moment the shape stops being a string. [`IpcError`] carries a machine
//! -readable [`IpcErrorKind`] alongside the human message.
//!
//! **This type lives in `termixion-tauri`, never in `termixion-core` (R1/R2).** Core owns
//! [`termixion_core::PtyError`], which already carries its own taxonomy; the mapping from that to
//! the wire happens here, at the boundary, so core never learns the IPC shape exists.

use serde::Serialize;
use termixion_core::PtyError;

/// Declares the kind enum and its complete variant list from ONE list of variants.
///
/// trmx-249: an earlier version hand-wrote `ALL` beside the enum and guarded it with a
/// wildcard-free `match`. That is not enough, and the gap is quiet: the match forces you to HANDLE
/// a new variant, not to LIST it. Add a variant plus its match arm and forget `ALL`, and everything
/// compiles, every test passes, and the wire vocabulary silently loses a kind — verified by doing
/// exactly that and watching six tests stay green. Generating both from one list is what actually
/// makes membership indivisible.
macro_rules! ipc_error_kinds {
    ($($(#[$doc:meta])* $variant:ident),+ $(,)?) => {
        /// The machine-readable class of an [`IpcError`]. Serialized in `snake_case` as the wire
        /// `kind`. The frontend mirrors this as `IPC_ERROR_KINDS` and compares the two against the
        /// shared golden fixture, so a variant added here fails the TypeScript suite until mirrored.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        #[serde(rename_all = "snake_case")]
        pub enum IpcErrorKind {
            $($(#[$doc])* $variant),+
        }

        impl IpcErrorKind {
            /// Every variant, in declaration order.
            ///
            /// Generated from the same list as the enum, so it cannot omit one. Not called by
            /// production code — it exists so the wire vocabulary is DERIVED rather than listed.
            #[allow(dead_code)]
            pub const ALL: &'static [IpcErrorKind] = &[$(IpcErrorKind::$variant),+];
        }
    };
}

ipc_error_kinds! {
    /// A PTY session id the registry has never seen or has already removed.
    NotFound,
    /// The session exists but its child has exited.
    NotRunning,
    /// Spawning a child failed.
    Spawn,
    /// A requested PTY size had zero rows or cols.
    InvalidSize,
    /// A filesystem or OS-opener failure: read, write, create, replace, resolve, reveal.
    Io,
    /// The caller supplied something we reject on inspection — an unknown settings key, a wrong
    /// value type, an empty or path-bearing theme name, an unknown log level, an oversized message.
    Invalid,
    /// An invariant we control was violated: a poisoned mutex, a constructed path with no parent
    /// or no file name, a window that would not open. Never the caller's fault.
    Internal,
}

/// The rejection payload: a machine-readable [`IpcErrorKind`] plus the message that was always
/// there. Serializing a struct (rather than a `String`) is what changes the wire shape, so every
/// consumer must go through the frontend decoder — see `app/src/ipc/backend.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IpcError {
    pub kind: IpcErrorKind,
    pub message: String,
}

impl IpcError {
    pub fn new(kind: IpcErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// A filesystem / opener failure.
    pub fn io(message: impl Into<String>) -> Self {
        Self::new(IpcErrorKind::Io, message)
    }

    /// A caller-supplied value we reject on inspection.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(IpcErrorKind::Invalid, message)
    }

    /// An invariant we control was violated.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(IpcErrorKind::Internal, message)
    }
}

/// Renders just the message, so `{err}` and `err.to_string()` read exactly as they did when these
/// commands rejected with a bare `String`. The kind travels on the wire, not in the human text.
impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// The one mapping from core's taxonomy to the wire. Deliberately total over `PtyError`: a new
/// core variant fails to compile here rather than silently degrading to a generic kind.
impl From<PtyError> for IpcError {
    fn from(error: PtyError) -> Self {
        let message = error.to_string();
        let kind = match error {
            PtyError::NotFound(_) => IpcErrorKind::NotFound,
            PtyError::NotRunning => IpcErrorKind::NotRunning,
            PtyError::Spawn(_) => IpcErrorKind::Spawn,
            PtyError::Io(_) => IpcErrorKind::Io,
            PtyError::InvalidSize(_) => IpcErrorKind::InvalidSize,
        };
        Self { kind, message }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termixion_core::PtySize;

    #[test]
    fn kinds_serialize_as_snake_case() {
        let wire: Vec<String> = IpcErrorKind::ALL
            .iter()
            .map(|k| {
                serde_json::to_value(k)
                    .expect("kind serializes")
                    .as_str()
                    .expect("a string")
                    .to_string()
            })
            .collect();
        assert_eq!(
            wire,
            vec![
                "not_found",
                "not_running",
                "spawn",
                "invalid_size",
                "io",
                "invalid",
                "internal"
            ]
        );
    }

    #[test]
    fn every_pty_error_variant_maps() {
        let cases: Vec<(PtyError, IpcErrorKind)> = vec![
            (PtyError::NotFound(7), IpcErrorKind::NotFound),
            (PtyError::NotRunning, IpcErrorKind::NotRunning),
            (PtyError::Spawn("boom".into()), IpcErrorKind::Spawn),
            (PtyError::Io("disk".into()), IpcErrorKind::Io),
            (
                PtyError::InvalidSize(PtySize { rows: 0, cols: 0 }),
                IpcErrorKind::InvalidSize,
            ),
        ];
        for (error, expected) in cases {
            let display = error.to_string();
            let mapped = IpcError::from(error);
            assert_eq!(mapped.kind, expected);
            assert_eq!(
                mapped.message, display,
                "the message must survive the mapping"
            );
        }
    }

    /// The cross-language contract (trmx-249). This test ASSERTS the committed fixture; it never
    /// rewrites it. A test that regenerates its own expectation asserts nothing, and makes results
    /// depend on suite order. `app/src/ipc/ipcErrorGolden.test.ts` reads the same file.
    #[test]
    fn golden_pins_the_wire_contract() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/ipc-error-golden.json"))
                .expect("the golden fixture parses");

        // 1. SHAPE — the real Tauri rejection payload for a real core error, not a hand-built struct.
        let rejected = tauri::ipc::InvokeError::from(IpcError::from(PtyError::NotFound(7))).0;
        assert_eq!(
            rejected, golden["sample"],
            "the IPC rejection shape drifted from tests/fixtures/ipc-error-golden.json"
        );

        // 2. VOCABULARY — every kind, derived from ALL (which the compiler keeps exhaustive), so a
        // new variant cannot slip past a fixture that only ever carried the sample's kind.
        let vocabulary = serde_json::Value::Array(
            IpcErrorKind::ALL
                .iter()
                .map(|k| serde_json::to_value(k).expect("kind serializes"))
                .collect(),
        );
        assert_eq!(
            vocabulary, golden["vocabulary"],
            "the IpcErrorKind vocabulary drifted from the golden fixture"
        );
    }

    /// Acceptance "reach" (trmx-249): serializing a standalone `IpcError` proves nothing about the
    /// COMMANDS — all 15 could still be `Result<_, String>` and every other test here would pass.
    ///
    /// trmx-300: this PARSES the signatures. Two string-matching versions leaked — a
    /// fully-qualified `crate::ipc_error::IpcError` read as infallible, a
    /// `CommandOutcome<T, IpcError>` read as fallible, and `pub mod x;` escaped the module
    /// self-check. A heuristic over source text keeps finding new ways to be wrong; the parse
    /// answers the actual question: is the return type `Result<_, IpcError>`?
    #[test]
    fn exactly_the_expected_commands_reject_with_ipc_error() {
        const EXPECTED_FALLIBLE: [&str; 15] = [
            "open_pty",
            "pty_write",
            "pty_resize",
            "close_pty",
            "config_write",
            "config_reset_all",
            "config_open_file",
            "themes_write",
            "themes_open_dir",
            "log_message",
            "log_dir",
            "log_open_dir",
            "scripts_open_dir",
            "shell_integration_reveal",
            "open_settings_window",
        ];
        const EXPECTED_INFALLIBLE: [&str; 18] = [
            "core_version",
            "take_pending_open_paths",
            "pty_ack",
            "smoke_config",
            "smoke_done",
            "perf_config",
            "perf_done",
            "config_read",
            "shells_list",
            "effective_shell",
            "keys_read",
            "themes_read",
            "scripts_list",
            "control_response",
            "enhancements_status",
            "quit_confirmed",
            "webview_close_request",
            "close_acknowledged",
        ];

        const SOURCES: [(&str, &str); 18] = [
            ("main", include_str!("main.rs")),
            ("close_gate", include_str!("close_gate.rs")),
            ("config_io", include_str!("config_io.rs")),
            ("control", include_str!("control.rs")),
            ("enhancements_io", include_str!("enhancements_io.rs")),
            ("fs_watch", include_str!("fs_watch.rs")),
            ("ipc_error", include_str!("ipc_error.rs")),
            ("launch", include_str!("launch.rs")),
            ("logging", include_str!("logging.rs")),
            ("menu", include_str!("menu.rs")),
            ("poller", include_str!("poller.rs")),
            ("pty_io", include_str!("pty_io.rs")),
            ("scripts_io", include_str!("scripts_io.rs")),
            ("services_io", include_str!("services_io.rs")),
            (
                "shell_integration_io",
                include_str!("shell_integration_io.rs"),
            ),
            ("shells_io", include_str!("shells_io.rs")),
            ("themes_io", include_str!("themes_io.rs")),
            ("window_manager", include_str!("window_manager.rs")),
        ];

        let main_rs = include_str!("main.rs");
        let parsed: Vec<(&str, syn::File)> = SOURCES
            .iter()
            .map(|(name, src)| {
                (
                    *name,
                    syn::parse_file(src).unwrap_or_else(|e| panic!("{name}.rs parses: {e}")),
                )
            })
            .collect();

        // COVERAGE SELF-CHECK. Every `mod x;` declared in main.rs must be censused — at ANY
        // visibility, which is where the previous `strip_prefix("mod ")` version failed.
        let main_ast = &parsed
            .iter()
            .find(|(name, _)| *name == "main")
            .expect("main.rs is censused")
            .1;
        for item in &main_ast.items {
            if let syn::Item::Mod(module) = item {
                // Only FILE modules (`mod x;`). An inline `mod x { .. }` — main.rs's own
                // `#[cfg(test)] mod tests` — carries its body here and needs no separate source.
                if module.content.is_some() {
                    continue;
                }
                let name = module.ident.to_string();
                assert!(
                    SOURCES.iter().any(|(known, _)| *known == name),
                    "module `{name}` is not in the census SOURCES — it could host an unnoticed command"
                );
            }
        }

        /// True when the return type is exactly `Result<_, IpcError>`.
        ///
        /// Checks the OUTER type is `Result` (so `CommandOutcome<T, IpcError>` does not count) and
        /// that its error argument's final path segment is `IpcError` (so a fully-qualified
        /// `crate::ipc_error::IpcError` does count).
        fn rejects_with_ipc_error(function: &syn::ItemFn) -> bool {
            let syn::ReturnType::Type(_, ty) = &function.sig.output else {
                return false;
            };
            let syn::Type::Path(path) = ty.as_ref() else {
                return false;
            };
            let Some(last) = path.path.segments.last() else {
                return false;
            };
            if last.ident != "Result" {
                return false;
            }
            let syn::PathArguments::AngleBracketed(args) = &last.arguments else {
                return false;
            };
            let Some(syn::GenericArgument::Type(syn::Type::Path(err))) = args.args.iter().nth(1)
            else {
                return false;
            };
            err.path
                .segments
                .last()
                .is_some_and(|segment| segment.ident == "IpcError")
        }

        let is_command = |function: &syn::ItemFn| {
            function.attrs.iter().any(|attr| {
                attr.path()
                    .segments
                    .last()
                    .is_some_and(|s| s.ident == "command")
            })
        };

        let mut fallible: Vec<String> = Vec::new();
        let mut infallible: Vec<String> = Vec::new();
        for (_, file) in &parsed {
            for item in &file.items {
                if let syn::Item::Fn(function) = item {
                    if !is_command(function) {
                        continue;
                    }
                    let name = function.sig.ident.to_string();
                    if rejects_with_ipc_error(function) {
                        fallible.push(name);
                    } else {
                        infallible.push(name);
                    }
                }
            }
        }

        // The registration list is the boundary: a command not in it is unreachable from the
        // webview, whatever its signature says.
        let block = main_rs
            .split_once("tauri::generate_handler![")
            .expect("main.rs registers commands")
            .1
            .split_once("])")
            .expect("the handler list closes")
            .0;
        let registered: Vec<&str> = block
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty() && !entry.starts_with("//"))
            .map(|entry| entry.rsplit("::").next().expect("a command name"))
            .collect();
        assert_eq!(
            registered.len(),
            33,
            "the registered command count changed: {registered:?}"
        );

        let sorted = |mut names: Vec<String>| {
            names.retain(|name| registered.contains(&name.as_str()));
            names.sort();
            names
        };
        let mut expected_fallible: Vec<String> =
            EXPECTED_FALLIBLE.iter().map(|s| (*s).to_string()).collect();
        let mut expected_infallible: Vec<String> = EXPECTED_INFALLIBLE
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        expected_fallible.sort();
        expected_infallible.sort();

        assert_eq!(
            sorted(fallible),
            expected_fallible,
            "the set of commands rejecting with IpcError drifted from the 15 this issue covers"
        );
        assert_eq!(
            sorted(infallible),
            expected_infallible,
            "the set of commands with NO error channel drifted from the 18 this issue leaves alone"
        );
    }

    #[test]
    fn serializes_as_kind_and_message() {
        let value =
            serde_json::to_value(IpcError::io("could not create /x")).expect("IpcError serializes");
        assert_eq!(
            value,
            serde_json::json!({ "kind": "io", "message": "could not create /x" })
        );
    }
}
