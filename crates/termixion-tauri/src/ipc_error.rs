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

/// The machine-readable class of an [`IpcError`]. Serialized in `snake_case` as the wire `kind`.
///
/// The frontend mirrors this as a `IPC_ERROR_KINDS` tuple and compares the two against a golden
/// fixture, so a variant added here without updating that tuple fails the TypeScript suite.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IpcErrorKind {
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

impl IpcErrorKind {
    /// Every variant, in wire order.
    ///
    /// Not called by production code — it exists so the WIRE VOCABULARY is derived from the enum
    /// rather than hand-listed. The golden test serializes it into the shared fixture, and the
    /// TypeScript suite compares its own tuple against that. Deleting it would silently reduce the
    /// contract to the one kind the sample happens to carry.
    #[allow(dead_code)]
    ///
    /// Exhaustiveness is the compiler's job, not the author's: [`Self::assert_exhaustive`] matches
    /// on every variant with no wildcard arm, so adding a variant without extending `ALL` fails to
    /// build. A hand-maintained list cannot guard against a hand-maintenance mistake.
    pub const ALL: [IpcErrorKind; 7] = [
        IpcErrorKind::NotFound,
        IpcErrorKind::NotRunning,
        IpcErrorKind::Spawn,
        IpcErrorKind::InvalidSize,
        IpcErrorKind::Io,
        IpcErrorKind::Invalid,
        IpcErrorKind::Internal,
    ];

    #[allow(dead_code)]
    /// A wildcard-free match binding each variant to its index in [`Self::ALL`]. Adding a variant
    /// breaks this match (non-exhaustive pattern) *and* the length assertion below it.
    const fn assert_exhaustive(self) -> usize {
        match self {
            IpcErrorKind::NotFound => 0,
            IpcErrorKind::NotRunning => 1,
            IpcErrorKind::Spawn => 2,
            IpcErrorKind::InvalidSize => 3,
            IpcErrorKind::Io => 4,
            IpcErrorKind::Invalid => 5,
            IpcErrorKind::Internal => 6,
        }
    }
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
    fn all_is_exhaustive_and_ordered() {
        // If a variant is added without extending ALL, `assert_exhaustive` fails to compile.
        // This asserts the two agree on ORDER and LENGTH, which the compiler cannot.
        for (index, kind) in IpcErrorKind::ALL.iter().enumerate() {
            assert_eq!(
                kind.assert_exhaustive(),
                index,
                "ALL is out of order at {index}"
            );
        }
    }

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
    /// This reads the authoritative registration list in `main.rs` and the command modules, and
    /// asserts the EXACT name sets rather than counts. A count cannot notice that one command
    /// entered the fallible set as another left it.
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

        // The registration list is the boundary: a command not in it is not reachable from the
        // webview, whatever its signature says.
        let main_rs = include_str!("main.rs");
        let block = main_rs
            .split_once("tauri::generate_handler![")
            .expect("main.rs registers commands")
            .1
            .split_once("])")
            .expect("the handler list closes")
            .0;
        let registered: Vec<&str> = block
            .split(',')
            .map(|entry| entry.trim())
            .filter(|entry| !entry.is_empty() && !entry.starts_with("//"))
            .map(|entry| entry.rsplit("::").next().expect("a command name"))
            .collect();
        assert_eq!(
            registered.len(),
            33,
            "the registered command count changed: {registered:?}"
        );

        // Every module that can host a fallible command.
        let sources: [&str; 7] = [
            include_str!("pty_io.rs"),
            include_str!("config_io.rs"),
            include_str!("themes_io.rs"),
            include_str!("logging.rs"),
            include_str!("scripts_io.rs"),
            include_str!("shell_integration_io.rs"),
            include_str!("window_manager.rs"),
        ];

        let rejects_with_ipc_error = |name: &str| {
            sources.iter().any(|src| {
                src.split(&format!("fn {name}(")).skip(1).any(|tail| {
                    // The signature ends at the opening brace of the body.
                    let head = tail.split_once(" {").map_or(tail, |(h, _)| h);
                    head.contains("IpcError")
                })
            })
        };

        let actual: Vec<&str> = registered
            .iter()
            .copied()
            .filter(|name| rejects_with_ipc_error(name))
            .collect();

        let mut expected = EXPECTED_FALLIBLE.to_vec();
        let mut got = actual.clone();
        expected.sort_unstable();
        got.sort_unstable();
        assert_eq!(
            got, expected,
            "the set of commands rejecting with IpcError drifted from the 15 this issue covers"
        );

        // And the other 18 keep no error channel at all — the scope line, asserted rather than assumed.
        assert_eq!(registered.len() - actual.len(), 18);
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
