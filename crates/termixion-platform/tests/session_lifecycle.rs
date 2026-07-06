// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// C-1 acceptance: the full core `Session` lifecycle driven through the trait against a real macOS
// PTY — spawn the login shell, resize, write, read back, tear down with no zombie. macOS-only (the
// whole file compiles away elsewhere), since it uses the `termixion-platform` macOS backend.
#![cfg(unix)]

use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use termixion_core::{PtyReader, PtySize, Session, SessionRegistry, SessionSpec};
use termixion_platform::UnixPtyFactory;

/// The process state of `pid` via `ps -o stat=` — `None` if the pid is gone, else the state string
/// (a leading `Z` means a zombie). We check the *zombie state* specifically, not mere existence,
/// because a freed pid can be reused by an unrelated process (e.g. a `cargo` subprocess during a
/// full-workspace `cargo test`) — and a reused *live* process must not be mistaken for our leak.
fn process_state(pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None; // pid no longer exists — reaped and gone
    }
    let state = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if state.is_empty() { None } else { Some(state) }
}

fn assert_no_zombie(pid: u32) {
    // A killed child must be REAPED AND GONE — teardown (UnixPtyBackend::kill) waits on the child
    // synchronously, so `ps` must stop reporting the pid. A persistent `Z…` state is the classic
    // zombie leak; a persistent *live* state is worse (the kill never landed / an orphan survived)
    // and must fail just as loudly — merely "not a zombie" would hide a still-running child
    // (trmx-74 review). The 2 s deadline only lets an in-flight reap settle; the residual
    // pid-reuse race (freed pid re-issued to an unrelated process within the window) is accepted —
    // macOS allocates pids forward, making a same-window reuse vanishingly unlikely.
    let mut last_state: Option<String> = None;
    for _ in 0..40 {
        match process_state(pid) {
            None => return, // reaped & gone — the only pass
            Some(state) => {
                last_state = Some(state);
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let state = last_state.unwrap_or_default();
    if state.starts_with('Z') {
        panic!("child pid {pid} was left as a zombie after teardown (state {state})");
    }
    panic!(
        "child pid {pid} is still alive after teardown (state {state}) — kill/reap never landed"
    );
}

#[test]
fn session_lifecycle_through_the_trait_leaves_no_zombie() {
    let factory = UnixPtyFactory;
    // A deterministic, rc-free interactive shell. A golden integration test must NOT source the
    // developer's / CI's shell rc files: they run prompt/precmd hooks (often git-aware ones) that
    // misbehave when this very test runs inside a `git push` pre-push hook. `zsh -f` (NO_RCS) skips
    // all startup files. The login-shell *resolver* (`SessionSpec::login_shell`) is unit-tested
    // separately in `termixion-core`; here we only need a real PTY + a shell that runs our command.
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.args.push("-f".into());
    let mut session = Session::spawn(1, &factory, &spec, PtySize::new(24, 80))
        .expect("spawn an rc-free shell through the trait");

    // A real PTY exposes the child pid; capture it now (while alive) for the no-zombie check.
    let pid = session.process_id().expect("a real PTY has a child pid");
    assert!(session.is_alive());

    // resize is part of the lifecycle.
    session
        .resize(PtySize::new(40, 120))
        .expect("resize the live pty");
    assert_eq!(session.size(), PtySize::new(40, 120));

    // Write a command whose OUTPUT is "hello" but whose SOURCE text is not — `hel""lo` concatenates
    // to `hello`, so the literal "hello" can only come from the shell *executing* echo, not from the
    // PTY echoing the typed line. `; exit` makes the shell close, giving us a clean EOF (no hang).
    session
        .write(b"echo hel\"\"lo; exit\n")
        .expect("write to the pty");

    // Read to EOF (the shell exited): accumulate everything the child produced.
    let mut output = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        match session.read(&mut buf).expect("read from the pty") {
            0 => break, // EOF — the shell exited
            n => {
                output.extend_from_slice(&buf[..n]);
                if output.len() > (1 << 20) {
                    break; // hang guard; teardown below still reaps
                }
            }
        }
    }
    let text = String::from_utf8_lossy(&output);
    assert!(
        text.contains("hello"),
        "expected the shell to execute `echo` and emit 'hello'; got: {text:?}"
    );

    // Teardown: idempotent kill (the child already exited at EOF) marks the session not-alive.
    session
        .kill()
        .expect("kill is idempotent on an exited child");
    assert!(!session.is_alive());

    // The whole point of C-1: teardown left no zombie.
    assert_no_zombie(pid);
}

/// trmx-67: a resize must be observed by the **child**, not just recorded in our bookkeeping. The
/// lifecycle test above asserts `session.size()` after `.resize()` — our own remembered number —
/// but never proves the winsize reached the kernel side of the PTY. `stty size` asks the tty ioctl
/// for the child's winsize, so a `40 120` line in the output can only mean the resize actually
/// landed on the PTY (the spawn size was 24×80, and the echoed command text contains no digits).
#[test]
fn resize_winsize_is_observed_by_the_child() {
    let factory = UnixPtyFactory;
    // The same deterministic, rc-free interactive shell as the lifecycle test (see the rationale
    // there): `zsh -f` (NO_RCS) skips all startup files, so a dev/CI rc hook can never garble or
    // hang this golden test.
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.args.push("-f".into());
    let mut session = Session::spawn(2, &factory, &spec, PtySize::new(24, 80))
        .expect("spawn an rc-free shell through the trait");
    let pid = session.process_id().expect("a real PTY has a child pid");
    assert!(session.is_alive());

    session
        .resize(PtySize::new(40, 120))
        .expect("resize the live pty");

    // Reads block until data or EOF (the `PtyBackend` contract), so an in-test read loop could
    // hang past any deadline if broken plumbing produced no further output. Keep the wait bounded
    // like `assert_no_zombie`: move the blocking reader onto its own thread — the ADR-0001 split
    // `take_reader` exists for exactly this — and receive chunks over a channel with a deadline.
    let mut reader = session.take_reader().expect("a real PTY yields a reader");
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let pump = std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break, // EOF (shell exited) or a torn-down PTY
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // the test stopped listening
                    }
                }
            }
        }
    });

    // Ask the CHILD for its winsize; `stty size` prints "<rows> <cols>" straight from the ioctl.
    session.write(b"stty size\n").expect("write to the pty");

    // Read-until the child reports the post-resize winsize. The deadline is generous — it only
    // matters when the plumbing is actually broken, and a loaded CI box must not flake a green pin.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut transcript = Vec::new();
    while !String::from_utf8_lossy(&transcript).contains("40 120") {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            panic!(
                "child never reported the resized winsize `40 120` via `stty size`; transcript: {:?}",
                String::from_utf8_lossy(&transcript)
            );
        }
        match rx.recv_timeout(remaining) {
            Ok(chunk) => transcript.extend_from_slice(&chunk),
            // Timeout, or the pump ended early (EOF / read error — the shell died under us).
            Err(err) => panic!(
                "pty output ended before `stty size` reported `40 120` ({err}); transcript: {:?}",
                String::from_utf8_lossy(&transcript)
            ),
        }
    }

    // Teardown: kill the live shell (SIGKILL + reap). That closes the PTY, so the pump thread sees
    // EOF and exits — the join cannot hang — and the C-1 no-zombie invariant holds here too.
    session.kill().expect("kill the live shell");
    assert!(!session.is_alive());
    pump.join().expect("the reader thread exits at EOF");
    assert_no_zombie(pid);
}

// ---------------------------------------------------------------------------------------------
// trmx-74 (FR-2.1): the same golden lifecycle, driven through `SessionRegistry` — the multi-
// session collection a tab manager uses — instead of a bare `Session`. Same conventions as
// above: rc-free `zsh -f`, `ps -o stat=` zombie polling, pump-thread reads with deadlines.
// ---------------------------------------------------------------------------------------------

/// The deterministic, rc-free interactive shell every golden test here uses (see the rationale in
/// `session_lifecycle_through_the_trait_leaves_no_zombie`): `zsh -f` (NO_RCS) skips all startup
/// files, so a dev/CI rc hook can never garble or hang the transcript.
fn rc_free_zsh() -> SessionSpec {
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.args.push("-f".into());
    spec
}

/// Move a blocking [`PtyReader`] onto its own thread (ADR-0001 — the registry hands the reader out
/// at spawn for exactly this), forwarding chunks over a channel so every wait below stays bounded.
/// The pump exits at EOF or on a torn-down PTY, so joining it after `close`/`kill_all` cannot hang.
fn pump_reader(
    mut reader: Box<dyn PtyReader>,
) -> (mpsc::Receiver<Vec<u8>>, std::thread::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let pump = std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break, // EOF (shell exited) or a torn-down PTY
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // the test stopped listening
                    }
                }
            }
        }
    });
    (rx, pump)
}

/// Accumulate pumped chunks until the transcript contains `needle`, with the same deadline pattern
/// as `resize_winsize_is_observed_by_the_child`: generous, and only load-bearing when the plumbing
/// is actually broken. Panics (with the transcript) on timeout or if the output ends first.
fn read_until(rx: &mpsc::Receiver<Vec<u8>>, needle: &str, deadline: Instant) -> String {
    let mut transcript = Vec::new();
    while !String::from_utf8_lossy(&transcript).contains(needle) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            panic!(
                "pty output never contained {needle:?} before the deadline; transcript: {:?}",
                String::from_utf8_lossy(&transcript)
            );
        }
        match rx.recv_timeout(remaining) {
            Ok(chunk) => transcript.extend_from_slice(&chunk),
            // Timeout, or the pump ended early (EOF / read error — the shell died under us).
            Err(err) => panic!(
                "pty output ended before {needle:?} appeared ({err}); transcript: {:?}",
                String::from_utf8_lossy(&transcript)
            ),
        }
    }
    String::from_utf8_lossy(&transcript).into_owned()
}

/// trmx-74: closing ONE registry session reaps ONLY its own child. Two real shells through one
/// registry; each proves independent routing by echoing its own marker (the `hel""lo` trick from
/// the lifecycle test — the literal marker can only come from the shell *executing* echo), then
/// `close(id1)` must reap pid1 while session 2 stays alive AND still answers a round-trip.
#[test]
fn registry_close_reaps_only_its_own_child() {
    let factory = UnixPtyFactory;
    let mut registry = SessionRegistry::new();
    let (id1, reader1) = registry
        .spawn(&factory, &rc_free_zsh(), PtySize::new(24, 80))
        .expect("spawn session 1 through the registry");
    let (id2, reader2) = registry
        .spawn(&factory, &rc_free_zsh(), PtySize::new(24, 80))
        .expect("spawn session 2 through the registry");
    let pid1 = registry
        .process_id(id1)
        .expect("session 1 is live")
        .expect("a real PTY has a child pid");
    let pid2 = registry
        .process_id(id2)
        .expect("session 2 is live")
        .expect("a real PTY has a child pid");
    let (rx1, pump1) = pump_reader(reader1);
    let (rx2, pump2) = pump_reader(reader2);

    // Distinguishable round-trip on EACH session via its OWN reader: writes routed by id must come
    // back on the matching PTY, not the other one.
    let deadline = Instant::now() + Duration::from_secs(10);
    registry
        .write(id1, b"echo fir\"\"st-marker\n")
        .expect("write to session 1");
    registry
        .write(id2, b"echo sec\"\"ond-marker\n")
        .expect("write to session 2");
    read_until(&rx1, "first-marker", deadline);
    read_until(&rx2, "second-marker", deadline);

    // Close session 1: its child must be reaped (gone or zombie-free, per the ps convention)...
    registry.close(id1).expect("close session 1");
    assert_no_zombie(pid1);
    pump1
        .join()
        .expect("session 1's reader thread exits at EOF");

    // ...while session 2's child is UNTOUCHED: still a live (non-zombie) process...
    let state2 = process_state(pid2).expect("session 2's child must survive session 1's close");
    assert!(
        !state2.starts_with('Z'),
        "session 2's child (pid {pid2}) must not be a zombie after closing session 1; state: {state2:?}"
    );
    assert_eq!(registry.ids(), vec![id2]);

    // ...and still answering a full write/read round-trip.
    registry
        .write(id2, b"echo sti\"\"ll-alive\n")
        .expect("write to session 2 after session 1's close");
    read_until(
        &rx2,
        "still-alive",
        Instant::now() + Duration::from_secs(10),
    );

    // Then session 2 closes and reaps just the same.
    registry.close(id2).expect("close session 2");
    assert_no_zombie(pid2);
    pump2
        .join()
        .expect("session 2's reader thread exits at EOF");
    assert!(registry.is_empty());
}

/// trmx-74: `SessionSpec::cwd` must reach the real child. Spawn into a unique temp dir and have
/// the shell report `pwd` — the dir path can only appear in the transcript if the kernel-side
/// chdir actually happened (the typed command `pwd` contains no path). macOS `/tmp` and `/var`
/// are symlinks into `/private`, so both the spec's cwd and the needle use the CANONICAL path.
#[test]
fn registry_spawn_honors_spec_cwd() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("the clock is past the epoch")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("trmx74-cwd-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create the temp cwd for the spawned shell");
    let dir = dir
        .canonicalize()
        .expect("canonicalize the temp cwd (macOS /tmp is a symlink into /private)");
    let needle = dir.to_str().expect("the temp cwd path is valid UTF-8");

    let factory = UnixPtyFactory;
    let mut registry = SessionRegistry::new();
    let mut spec = rc_free_zsh();
    spec.cwd = Some(dir.clone());
    let (id, reader) = registry
        .spawn(&factory, &spec, PtySize::new(24, 80))
        .expect("spawn a shell with an explicit cwd through the registry");
    let pid = registry
        .process_id(id)
        .expect("the session is live")
        .expect("a real PTY has a child pid");
    let (rx, pump) = pump_reader(reader);

    registry
        .write(id, b"pwd\n")
        .expect("write `pwd` to the pty");
    read_until(&rx, needle, Instant::now() + Duration::from_secs(10));

    registry.close(id).expect("close the session");
    assert_no_zombie(pid);
    pump.join().expect("the reader thread exits at EOF");
    std::fs::remove_dir_all(&dir).expect("remove the temp cwd");
}

/// trmx-74: `kill_all` (window close) reaps EVERY child and leaves the registry empty — the
/// multi-session version of the C-1 no-zombie invariant. No reads are needed: SIGKILL + reap do
/// not depend on the readers, and a fresh `zsh -f` prompt fits the kernel PTY buffer, so holding
/// the unpumped readers on the test thread cannot deadlock the kill.
#[test]
fn registry_kill_all_leaves_no_zombies() {
    let factory = UnixPtyFactory;
    let mut registry = SessionRegistry::new();
    let (id1, _reader1) = registry
        .spawn(&factory, &rc_free_zsh(), PtySize::new(24, 80))
        .expect("spawn session 1 through the registry");
    let (id2, _reader2) = registry
        .spawn(&factory, &rc_free_zsh(), PtySize::new(24, 80))
        .expect("spawn session 2 through the registry");
    let pid1 = registry
        .process_id(id1)
        .expect("session 1 is live")
        .expect("a real PTY has a child pid");
    let pid2 = registry
        .process_id(id2)
        .expect("session 2 is live")
        .expect("a real PTY has a child pid");
    assert_eq!(registry.len(), 2);

    registry.kill_all();

    assert_no_zombie(pid1);
    assert_no_zombie(pid2);
    assert!(registry.is_empty());
}
