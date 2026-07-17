// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! The platform-agnostic PTY seam: the traits and value types that `termixion-platform`
//! implements (macOS via portable-pty in B-2). The core only *declares* the seam — no platform
//! code, no platform crates.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

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
    /// A requested size had zero rows or zero cols — a PTY grid is at least 1x1.
    InvalidSize(PtySize),
    /// No session with this id exists in the registry (trmx-74). Distinct from [`PtyError::NotRunning`]:
    /// `NotRunning` is a session that exists but whose child exited; `NotFound` is an id the registry
    /// has never seen or has already removed.
    NotFound(crate::session::SessionId),
}

impl fmt::Display for PtyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PtyError::NotRunning => write!(f, "pty session is not running"),
            PtyError::Spawn(msg) => write!(f, "failed to spawn pty session: {msg}"),
            PtyError::Io(msg) => write!(f, "pty I/O error: {msg}"),
            PtyError::InvalidSize(size) => write!(
                f,
                "invalid pty size: {} rows x {} cols (both must be nonzero)",
                size.rows, size.cols
            ),
            PtyError::NotFound(id) => write!(f, "no session with id {id}"),
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

/// The terminal type Termixion advertises to the child shell via `TERM`. Termixion renders through
/// xterm.js, so `xterm-256color` is the terminfo entry whose capabilities the emulator actually
/// implements — the same value VS Code, Hyper, and other xterm.js front-ends export.
pub const DEFAULT_TERM: &str = "xterm-256color";

/// The color-depth advertisement Termixion exports to the child shell via `COLORTERM` (trmx-179).
/// The emulator (xterm.js 5.5) renders 24-bit truecolor exactly — pinned by the trmx-64
/// conformance harness — but [`DEFAULT_TERM`]'s terminfo entry carries no `RGB` capability, so
/// without this variable color-depth auto-detection in child programs (nvim's `termguicolors`,
/// `bat`, `delta`, the `supports-color` family) downgrades output to the 256-color palette.
/// `COLORTERM=truecolor` is the de facto advertising convention — iTerm2, Kitty, and VS Code's
/// terminal all export it. (Switching `TERM` to `xterm-direct`, the terminfo-pure alternative,
/// was rejected: its palette-capability differences break real applications; mainstream
/// terminals stay on `xterm-256color` + `COLORTERM`.)
pub const DEFAULT_COLORTERM: &str = "truecolor";

/// The `LANG` a login shell is given when the inherited environment carries **no locale at all**
/// (trmx-145). A GUI launch (Finder / the `.app` bundle under `launchd`) inherits none of
/// `LANG`/`LC_ALL`/`LC_CTYPE`, leaving the child shell in the C locale — where zsh's line editor
/// renders pasted/typed multi-byte UTF-8 as `<00XX>` garbage that then re-copies faithfully and
/// masquerades as clipboard corruption. Terminal.app and iTerm2 set locale variables for spawned
/// shells for the same reason. `en_US.UTF-8` ships on every macOS install, and it is the ctype
/// (UTF-8) that matters here, not the language.
pub const DEFAULT_UTF8_LANG: &str = "en_US.UTF-8";

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

    /// A spec for the user's login shell (resolved from `$SHELL`, falling back to `/bin/zsh`).
    ///
    /// v0.0.1 spawns it interactively; true login semantics (argv0 `-`, `-l`, rc-file nuances) are a
    /// later concern. Reads `$SHELL` here and delegates the (pure) choice to [`login_shell_program`].
    ///
    /// Sets `TERM` to [`DEFAULT_TERM`] so the child always knows the terminal type Termixion presents,
    /// regardless of how Termixion itself was launched. A GUI launch (Finder / the `.app` bundle under
    /// `launchd`) inherits no `$TERM`, which left the child shell with no terminal type — breaking
    /// `clear` (*"TERM environment variable not set."*) and the zsh line editor's backspace/delete key
    /// bindings (trmx-37). This forced value also overrides any inherited `$TERM` (the platform backend
    /// layers `spec.env` over the inherited environment): the inherited value describes whatever
    /// terminal Termixion runs *in*, not the xterm.js surface Termixion presents to its child.
    ///
    /// Sets `COLORTERM` to [`DEFAULT_COLORTERM`] so color-depth auto-detection in child
    /// programs sees the 24-bit surface the emulator actually renders (trmx-179). Forced like
    /// `TERM`, and for the same reason: an inherited `COLORTERM` describes whatever terminal
    /// Termixion runs *in*, never the xterm.js surface Termixion presents to its child — and
    /// that surface always renders truecolor, so the only honest value is unconditional.
    ///
    /// Sets `LANG` to [`DEFAULT_UTF8_LANG`] **only when the inherited environment carries no
    /// locale at all** (`LANG`, `LC_ALL`, and `LC_CTYPE` all unset or empty — the GUI-launch
    /// state, trmx-145). An explicit value in any of the three — even `C` — is user/process
    /// configuration and is respected as-is (POSIX precedence for the input-rendering symptom:
    /// `LC_ALL` > `LC_CTYPE` > `LANG`), so an explicitly non-UTF-8 environment keeps its
    /// behavior. Unlike `TERM` and `COLORTERM`, this never overrides an inherited value.
    ///
    /// Sets `cwd` to `$HOME` **when it is set, non-empty, and names a real directory**
    /// (trmx-185). A GUI launch (Finder / the `.app` bundle under `launchd`) runs with parent
    /// cwd `/`, so the inherit-parent default put every nothing-to-inherit session in the
    /// filesystem root; Terminal.app and iTerm2 start such sessions in the user's home. A
    /// missing/empty/non-directory `$HOME` keeps `cwd: None` (the inherit-parent contract)
    /// rather than becoming the platform layer's loud invalid-cwd spawn error. Callers that
    /// know better (the frontend's OSC-7 inheritance, an explicit `open_pty` cwd) overwrite
    /// this default after construction, exactly as before.
    pub fn login_shell() -> Self {
        Self::login_shell_with_env(|key| std::env::var_os(key), |path| path.is_dir())
    }

    /// [`login_shell`] over an injected environment lookup and `$HOME` directory probe (the
    /// house test seams, like [`login_shell_program`]'s injected probe): the closures fully
    /// determine the spec, so unit tests never read the process-global environment or the host
    /// filesystem. Production passes `std::env::var_os` and `Path::is_dir`.
    fn login_shell_with_env(
        env: impl Fn(&str) -> Option<OsString>,
        home_is_dir: impl Fn(&Path) -> bool,
    ) -> Self {
        let mut spec = Self::shell(login_shell_program(env("SHELL"), |p| {
            std::path::Path::new(p).exists()
        }));
        spec.cwd = default_home_cwd(&env, home_is_dir);
        spec.env
            .push((OsString::from("TERM"), OsString::from(DEFAULT_TERM)));
        spec.env.push((
            OsString::from("COLORTERM"),
            OsString::from(DEFAULT_COLORTERM),
        ));
        if locale_is_absent(&env) {
            spec.env
                .push((OsString::from("LANG"), OsString::from(DEFAULT_UTF8_LANG)));
        }
        spec
    }
}

/// The default working directory for a login-shell session (trmx-185): `$HOME`, but only when it
/// is set, non-empty, and names a real directory per the injected `is_dir` probe. Anything else →
/// `None`, preserving the inherit-parent contract — a homeless environment degrades to today's
/// behavior instead of tripping the platform layer's invalid-cwd spawn error downstream.
fn default_home_cwd(
    env: &impl Fn(&str) -> Option<OsString>,
    is_dir: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    env("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .filter(|home| is_dir(home))
}

/// True when the environment provides no locale signal at all: `LANG`, `LC_ALL`, and `LC_CTYPE`
/// each unset **or empty** (an observed real-world state is `LANG=''`). Only this total absence
/// triggers the [`DEFAULT_UTF8_LANG`] fallback — any explicit value, UTF-8 or not, wins.
fn locale_is_absent(env: &impl Fn(&str) -> Option<OsString>) -> bool {
    ["LANG", "LC_ALL", "LC_CTYPE"]
        .iter()
        .all(|key| env(key).is_none_or(|value| value.is_empty()))
}

/// Pick the login-shell program: a non-empty `$SHELL`, else `/bin/zsh` if present (the macOS default),
/// else `/bin/bash` (the zsh-less-Linux fallback, trmx-102). Pure — takes the env value + an `exists`
/// probe as arguments so it is testable without a real filesystem or the process-global environment.
fn login_shell_program(shell_env: Option<OsString>, exists: impl Fn(&str) -> bool) -> OsString {
    match shell_env {
        Some(shell) if !shell.is_empty() => shell,
        _ if exists("/bin/zsh") => OsString::from("/bin/zsh"),
        _ => OsString::from("/bin/bash"),
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

    /// The OS process id of the child, if known. Used for diagnostics and lifecycle assertions (e.g.
    /// confirming teardown left no process behind). Backends without a real child return `None`.
    fn process_id(&self) -> Option<u32> {
        None
    }

    /// Take the blocking **output reader** so it can be moved to a dedicated thread, leaving
    /// `write`/`resize`/`kill` usable concurrently on the backend (the transport in ADR-0001 needs to
    /// read on its own thread while keystrokes are written from command handlers). Returns `None` if
    /// the backend has no separable reader (the in-memory fake) or it was already taken. After a
    /// successful take, [`PtyBackend::read`] no longer yields output — the [`PtyReader`] does.
    fn take_reader(&mut self) -> Option<Box<dyn PtyReader>> {
        None
    }
}

/// The blocking **output half** of a PTY-backed session, split off via [`PtyBackend::take_reader`] so
/// it can be read on its own thread. Same contract as [`PtyBackend::read`]: blocks until data or EOF,
/// and `Ok(0)` means EOF.
pub trait PtyReader: Send {
    /// Read output into `buf` (blocking). Returns the byte count; `Ok(0)` means **EOF**.
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError>;
}

/// Spawns PTY-backed sessions. `termixion-platform` provides the real factory (macOS); tests and
/// downstream crates can use [`crate::fake::FakePtyFactory`].
pub trait PtyFactory {
    /// Spawn the session described by `spec` at the given initial `size`.
    fn spawn(&self, spec: &SessionSpec, size: PtySize) -> Result<Box<dyn PtyBackend>, PtyError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pty_size_new_and_default() {
        assert_eq!(
            PtySize::new(40, 120),
            PtySize {
                rows: 40,
                cols: 120
            }
        );
        // The documented conventional default is 80x24.
        assert_eq!(PtySize::default(), PtySize::new(24, 80));
    }

    #[test]
    fn pty_error_display_is_human_readable() {
        // Each variant renders a distinct, descriptive message (the Display impl is the only place
        // these strings live, and the shell surfaces them to the user).
        assert_eq!(
            PtyError::NotRunning.to_string(),
            "pty session is not running"
        );
        assert_eq!(
            PtyError::Spawn("boom".into()).to_string(),
            "failed to spawn pty session: boom"
        );
        assert_eq!(
            PtyError::Io("disk full".into()).to_string(),
            "pty I/O error: disk full"
        );
        assert_eq!(
            PtyError::InvalidSize(PtySize::new(0, 80)).to_string(),
            "invalid pty size: 0 rows x 80 cols (both must be nonzero)"
        );
        assert_eq!(PtyError::NotFound(7).to_string(), "no session with id 7");

        // It is a std::error::Error with no deeper source (we carry messages, not nested errors).
        let err: &dyn std::error::Error = &PtyError::NotRunning;
        assert!(err.source().is_none());
    }

    #[test]
    fn session_spec_shell_inherits_cwd_and_env() {
        let spec = SessionSpec::shell("/bin/zsh");
        assert_eq!(spec.program, std::ffi::OsString::from("/bin/zsh"));
        assert!(spec.args.is_empty());
        assert!(spec.cwd.is_none(), "shell() inherits the parent cwd");
        assert!(spec.env.is_empty());
    }

    #[test]
    fn login_shell_program_prefers_shell_env_then_falls_back() {
        // The resolver is pure (takes the env value + an `exists` probe) so it tests without a real
        // filesystem or mutating the process-global environment. Any exists → $SHELL always wins.
        let all = |_: &str| true;
        assert_eq!(
            login_shell_program(Some(OsString::from("/opt/homebrew/bin/fish")), all),
            OsString::from("/opt/homebrew/bin/fish")
        );
        // Unset/empty $SHELL: zsh present → /bin/zsh (the macOS default).
        assert_eq!(login_shell_program(None, all), OsString::from("/bin/zsh"));
        assert_eq!(
            login_shell_program(Some(OsString::new()), all),
            OsString::from("/bin/zsh")
        );
        // trmx-102: unset $SHELL AND no /bin/zsh (a zsh-less Linux box) → /bin/bash.
        let no_zsh = |p: &str| p != "/bin/zsh";
        assert_eq!(
            login_shell_program(None, no_zsh),
            OsString::from("/bin/bash")
        );
    }

    #[test]
    fn session_spec_login_shell_builds_a_bare_spec() {
        let spec = SessionSpec::login_shell();
        assert!(!spec.program.is_empty(), "a login shell must be resolved");
        assert!(spec.args.is_empty());
        // trmx-185: the cwd mirrors the process `$HOME` — `Some` exactly when it is set,
        // non-empty, and a real directory. Compute the expectation from the same env this test
        // runs under so a host without a usable $HOME still passes (the injected-seam tests
        // below pin each branch deterministically).
        let expected = std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from)
            .filter(|home| home.is_dir());
        assert_eq!(spec.cwd, expected);
    }

    /// An injected env lookup over a fixed pair list. Every test pins a non-empty `SHELL` so the
    /// resolver never falls through to the host-filesystem `/bin/zsh` probe — the injected env
    /// fully determines the spec (the Step-5 determinism pin).
    fn env_from(
        pairs: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&str) -> Option<OsString> {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| OsString::from(v))
        }
    }

    fn env_value(spec: &SessionSpec, key: &str) -> Option<OsString> {
        spec.env
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }

    #[test]
    fn login_shell_defaults_cwd_to_home_when_it_is_a_directory() {
        // trmx-185: a GUI launch (Finder / .app under launchd) has parent cwd `/`, so a login
        // session with nothing to inherit must start in $HOME (Terminal.app/iTerm2 parity).
        // The directory probe is injected — the test never touches the host filesystem.
        let spec = SessionSpec::login_shell_with_env(
            env_from(&[("SHELL", "/bin/zsh"), ("HOME", "/Users/tester")]),
            |path| path == std::path::Path::new("/Users/tester"),
        );
        assert_eq!(spec.cwd, Some(PathBuf::from("/Users/tester")));
        // The cwd policy must not disturb the existing env policy on the same spec.
        assert_eq!(env_value(&spec, "TERM"), Some(OsString::from(DEFAULT_TERM)));
        assert_eq!(
            env_value(&spec, "COLORTERM"),
            Some(OsString::from(DEFAULT_COLORTERM))
        );
    }

    #[test]
    fn login_shell_leaves_cwd_unset_without_a_usable_home() {
        // Unset, empty, and not-a-directory $HOME each keep the inherit-parent contract
        // (cwd None) — a homeless environment degrades to today's behavior instead of
        // becoming the platform layer's loud invalid-cwd spawn error.
        let unset = SessionSpec::login_shell_with_env(env_from(&[("SHELL", "/bin/zsh")]), |_| true);
        assert_eq!(unset.cwd, None, "unset HOME inherits the parent cwd");

        let empty = SessionSpec::login_shell_with_env(
            env_from(&[("SHELL", "/bin/zsh"), ("HOME", "")]),
            |_| true,
        );
        assert_eq!(empty.cwd, None, "empty HOME counts as unset");

        let bogus = SessionSpec::login_shell_with_env(
            env_from(&[("SHELL", "/bin/zsh"), ("HOME", "/nonexistent-home")]),
            |_| false,
        );
        assert_eq!(
            bogus.cwd, None,
            "a HOME that is not a directory inherits the parent cwd"
        );
    }

    #[test]
    fn login_shell_forces_utf8_lang_when_environment_has_no_locale() {
        // trmx-145 (reopened): a GUI launch (Finder/launchd) inherits no LANG/LC_ALL/LC_CTYPE,
        // leaving the child zsh in the C locale — ZLE then displays pasted/typed multi-byte
        // UTF-8 as `<00XX>` garbage, which re-copies faithfully and masquerades as clipboard
        // corruption. Same launch-context reasoning as the forced TERM (trmx-37).
        let spec = SessionSpec::login_shell_with_env(env_from(&[("SHELL", "/bin/zsh")]), |_| false);
        assert_eq!(
            env_value(&spec, "TERM"),
            Some(OsString::from("xterm-256color")),
            "the trmx-37 TERM contract must be unaffected"
        );
        assert_eq!(
            env_value(&spec, "LANG"),
            Some(OsString::from(DEFAULT_UTF8_LANG)),
            "a locale-less environment must get a UTF-8 LANG; got env {:?}",
            spec.env
        );
    }

    #[test]
    fn login_shell_treats_empty_locale_vars_as_unset() {
        // The observed broken machine state was LANG='' (empty string, not absent).
        let spec = SessionSpec::login_shell_with_env(
            env_from(&[
                ("SHELL", "/bin/zsh"),
                ("LANG", ""),
                ("LC_ALL", ""),
                ("LC_CTYPE", ""),
            ]),
            |_| false,
        );
        assert_eq!(
            env_value(&spec, "LANG"),
            Some(OsString::from(DEFAULT_UTF8_LANG)),
            "empty-string locale vars count as unset; got env {:?}",
            spec.env
        );
    }

    #[test]
    fn login_shell_respects_an_explicit_locale() {
        // Any of the three vars set non-empty — even to C — is explicit configuration; the spec
        // adds nothing and the child inherits it (POSIX precedence: LC_ALL > LC_CTYPE > LANG).
        for pinned in [
            ("LANG", "C"),
            ("LC_ALL", "C"),
            ("LC_CTYPE", "C"),
            ("LANG", "fr_FR.UTF-8"),
        ] {
            let pairs: &[(&str, &str)] = Box::leak(Box::new([("SHELL", "/bin/zsh"), pinned]));
            let spec = SessionSpec::login_shell_with_env(env_from(pairs), |_| false);
            assert_eq!(
                env_value(&spec, "LANG"),
                None,
                "with {pinned:?} set the spec must not force LANG; got env {:?}",
                spec.env
            );
        }
    }

    #[test]
    fn login_shell_advertises_truecolor_colorterm() {
        // trmx-179: the emulator renders 24-bit truecolor exactly (pinned by the trmx-64
        // conformance harness), but TERM=xterm-256color's terminfo carries no RGB capability —
        // so without COLORTERM, color-depth auto-detection in child programs (nvim's
        // termguicolors, bat, delta, the supports-color family) downgrades to the 256 palette.
        let spec = SessionSpec::login_shell_with_env(env_from(&[("SHELL", "/bin/zsh")]), |_| false);
        assert_eq!(
            env_value(&spec, "COLORTERM"),
            Some(OsString::from("truecolor")),
            "a login shell must advertise COLORTERM=truecolor; got env {:?}",
            spec.env
        );
        assert_eq!(
            env_value(&spec, "TERM"),
            Some(OsString::from(DEFAULT_TERM)),
            "the trmx-37 TERM contract must be unaffected"
        );

        // An inherited COLORTERM — even another spelling — is overridden, exactly like TERM:
        // the inherited value describes the terminal Termixion runs *in*, never the xterm.js
        // surface it presents to its child.
        let spec = SessionSpec::login_shell_with_env(
            env_from(&[("SHELL", "/bin/zsh"), ("COLORTERM", "24bit")]),
            |_| false,
        );
        assert_eq!(
            env_value(&spec, "COLORTERM"),
            Some(OsString::from("truecolor")),
            "an inherited COLORTERM must be overridden (forced, like TERM); got env {:?}",
            spec.env
        );
    }

    #[test]
    fn login_shell_advertises_xterm_term() {
        // Termixion renders through xterm.js, so the login shell must be told `TERM=xterm-256color`
        // explicitly — otherwise a GUI launch (Finder/launchd inherits no `$TERM`) leaves the child
        // shell with no terminal type, breaking `clear` and ZLE backspace/delete (trmx-37).
        let spec = SessionSpec::login_shell();
        let term = spec
            .env
            .iter()
            .find(|(k, _)| k == "TERM")
            .map(|(_, v)| v.as_os_str());
        assert_eq!(
            term,
            Some(OsString::from("xterm-256color").as_os_str()),
            "login_shell() must advertise TERM=xterm-256color; got env {:?}",
            spec.env
        );
    }
}
