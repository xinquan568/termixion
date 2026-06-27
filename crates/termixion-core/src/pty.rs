// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! The platform-agnostic PTY seam: the traits and value types that `termixion-platform`
//! implements (macOS via portable-pty in B-2). The core only *declares* the seam — no platform
//! code, no platform crates.

use std::ffi::OsString;
use std::fmt;
use std::path::PathBuf;

/// Terminal size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtySize {
    pub rows: u16,
    pub cols: u16,
}

impl PtySize {
    pub const fn new(rows: u16, cols: u16) -> Self {
        Self { rows, cols }
    }
}

impl Default for PtySize {
    /// A conventional 80x24 terminal.
    fn default() -> Self {
        Self { rows: 24, cols: 80 }
    }
}

/// Errors from PTY operations. Hand-written (no external deps) to keep `termixion-core`
/// dependency-free and Linux-buildable.
#[derive(Debug)]
pub enum PtyError {
    /// The session/child has already exited or been killed.
    NotRunning,
    /// Spawning the child failed.
    Spawn(String),
    /// An I/O error during read/write/resize/kill.
    Io(String),
}

impl fmt::Display for PtyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PtyError::NotRunning => write!(f, "pty session is not running"),
            PtyError::Spawn(msg) => write!(f, "failed to spawn pty session: {msg}"),
            PtyError::Io(msg) => write!(f, "pty I/O error: {msg}"),
        }
    }
}

impl std::error::Error for PtyError {}

/// What to spawn in a PTY.
///
/// Process metadata uses [`OsString`]/[`PathBuf`] (not `String`) so non-UTF-8 program paths,
/// arguments, and environment values — which real OS process APIs and `portable-pty` carry —
/// round-trip losslessly through the seam.
#[derive(Debug, Clone)]
pub struct SessionSpec {
    /// The program to run — typically the user's login shell.
    pub program: OsString,
    /// Arguments passed to `program`.
    pub args: Vec<OsString>,
    /// Working directory; `None` inherits the parent's.
    pub cwd: Option<PathBuf>,
    /// Extra environment as `(key, value)` pairs, layered over the inherited environment.
    pub env: Vec<(OsString, OsString)>,
}

impl SessionSpec {
    /// A spec that runs `program` with no args, inheriting cwd and environment.
    pub fn shell(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
        }
    }
}

/// The live I/O + control surface of one PTY-backed session.
///
/// Implemented by `termixion-platform`; the core only declares it.
///
/// `read` follows [`std::io::Read`] semantics for a **blocking** reader: it returns the number of
/// bytes read, and `Ok(0)` means **EOF** — the child exited and no more output will ever arrive. A
/// backend with no data available *right now* must **block** until data or EOF; it must not return
/// `Ok(0)` to mean "nothing yet". (The real macOS backend, B-2, is portable-pty's blocking reader,
/// which satisfies this.)
pub trait PtyBackend: Send {
    /// Write bytes to the PTY (the child's stdin). Returns the number of bytes written.
    fn write(&mut self, data: &[u8]) -> Result<usize, PtyError>;

    /// Read output into `buf` (blocking). Returns the byte count; `Ok(0)` means **EOF**. A
    /// zero-length `buf` reads nothing and returns `Ok(0)` without implying EOF.
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError>;

    /// Resize the PTY's character grid.
    fn resize(&mut self, size: PtySize) -> Result<(), PtyError>;

    /// Terminate the child process. Idempotent — killing an already-dead session is `Ok(())`.
    fn kill(&mut self) -> Result<(), PtyError>;
}

/// Spawns PTY-backed sessions. `termixion-platform` provides the real factory (macOS); tests and
/// downstream crates can use [`crate::fake::FakePtyFactory`].
pub trait PtyFactory {
    /// Spawn the session described by `spec` at the given initial `size`.
    fn spawn(&self, spec: &SessionSpec, size: PtySize) -> Result<Box<dyn PtyBackend>, PtyError>;
}
