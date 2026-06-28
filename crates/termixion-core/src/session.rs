// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! The single-session domain model — one PTY-backed terminal session with id / title / size /
//! liveness — independent of any platform. A tab manager owns a collection of these (P1-4, later).

use crate::pty::{PtyBackend, PtyError, PtyFactory, PtySize, SessionSpec};

/// Stable identifier for a session, assigned by the caller (e.g. the tab manager).
pub type SessionId = u64;

/// One terminal session: its backend plus the domain state the UI needs.
pub struct Session {
    id: SessionId,
    title: String,
    size: PtySize,
    alive: bool,
    backend: Box<dyn PtyBackend>,
}

impl Session {
    /// Spawn a new session via `factory`. The title defaults to the spec's program; callers may
    /// override it with [`Session::set_title`] (e.g. from an OSC title or the foreground process).
    pub fn spawn(
        id: SessionId,
        factory: &dyn PtyFactory,
        spec: &SessionSpec,
        size: PtySize,
    ) -> Result<Self, PtyError> {
        let backend = factory.spawn(spec, size)?;
        Ok(Self {
            id,
            title: spec.program.to_string_lossy().into_owned(),
            size,
            alive: true,
            backend,
        })
    }

    /// The session's stable id.
    pub fn id(&self) -> SessionId {
        self.id
    }

    /// The current title.
    pub fn title(&self) -> &str {
        &self.title
    }

    /// Override the title (manual rename, OSC title, or foreground-process name).
    pub fn set_title(&mut self, title: impl Into<String>) {
        self.title = title.into();
    }

    /// The last size set (initial size or the most recent [`Session::resize`]).
    pub fn size(&self) -> PtySize {
        self.size
    }

    /// Whether the session is still running (set false by [`Session::kill`]).
    ///
    /// B-2 augments this by marking a session not-alive when its backend reports EOF on `read`.
    pub fn is_alive(&self) -> bool {
        self.alive
    }

    /// Write user input to the PTY. Errors with [`PtyError::NotRunning`] once killed.
    pub fn write(&mut self, data: &[u8]) -> Result<usize, PtyError> {
        if !self.alive {
            return Err(PtyError::NotRunning);
        }
        self.backend.write(data)
    }

    /// Read output into `buf` (blocking on a real backend). `Ok(0)` means **EOF** — the child
    /// exited — and transitions the session to not-alive. A zero-length `buf` reads nothing.
    pub fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError> {
        if !self.alive || buf.is_empty() {
            return Ok(0);
        }
        let read = self.backend.read(buf)?;
        if read == 0 {
            // EOF: the child exited.
            self.alive = false;
        }
        Ok(read)
    }

    /// Resize the PTY and remember the new size. Errors with [`PtyError::NotRunning`] once killed.
    pub fn resize(&mut self, size: PtySize) -> Result<(), PtyError> {
        if !self.alive {
            return Err(PtyError::NotRunning);
        }
        self.backend.resize(size)?;
        self.size = size;
        Ok(())
    }

    /// Terminate the child. Idempotent; marks the session not-alive.
    pub fn kill(&mut self) -> Result<(), PtyError> {
        if !self.alive {
            return Ok(());
        }
        self.backend.kill()?;
        self.alive = false;
        Ok(())
    }

    /// The OS process id of the underlying child, if the backend exposes one (a real PTY does; the
    /// in-memory fake does not).
    pub fn process_id(&self) -> Option<u32> {
        self.backend.process_id()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::FakePtyFactory;

    #[test]
    fn spawn_write_read_resize_title_kill() {
        let factory = FakePtyFactory;
        let spec = SessionSpec::shell("/bin/zsh");
        let mut session =
            Session::spawn(7, &factory, &spec, PtySize::new(24, 80)).expect("spawn should succeed");

        assert_eq!(session.id(), 7);
        assert_eq!(session.title(), "/bin/zsh");
        assert!(session.is_alive());
        assert_eq!(session.size(), PtySize::new(24, 80));

        // write -> read-back (the fake is a loopback).
        let written = session.write(b"echo hi\n").expect("write");
        assert_eq!(written, 8);
        let mut buf = [0u8; 32];
        let read = session.read(&mut buf).expect("read");
        assert_eq!(&buf[..read], b"echo hi\n");

        // resize updates the stored size.
        session.resize(PtySize::new(40, 120)).expect("resize");
        assert_eq!(session.size(), PtySize::new(40, 120));

        // title override.
        session.set_title("vim");
        assert_eq!(session.title(), "vim");

        // kill -> not alive, further writes error, kill is idempotent.
        session.kill().expect("kill");
        assert!(!session.is_alive());
        assert!(matches!(session.write(b"x"), Err(PtyError::NotRunning)));
        assert!(matches!(
            session.resize(PtySize::default()),
            Err(PtyError::NotRunning)
        ));
        assert_eq!(session.read(&mut buf).expect("read after kill"), 0);
        session.kill().expect("kill is idempotent");
    }

    #[test]
    fn read_eof_marks_session_not_alive() {
        // The other end of the is_alive() contract: a backend that reports EOF (Ok(0)) on read —
        // because the child exited — transitions the session to not-alive, distinct from kill().
        let factory = FakePtyFactory;
        let spec = SessionSpec::shell("/bin/sh");
        let mut session = Session::spawn(1, &factory, &spec, PtySize::default()).expect("spawn");
        assert!(session.is_alive());

        // Nothing was written, so the loopback is already drained -> read returns EOF.
        let mut buf = [0u8; 16];
        assert_eq!(session.read(&mut buf).expect("read at eof"), 0);
        assert!(!session.is_alive(), "EOF must mark the session not-alive");

        // Once not-alive, write/resize error and a further read short-circuits to 0.
        assert!(matches!(session.write(b"x"), Err(PtyError::NotRunning)));
        assert_eq!(session.read(&mut buf).expect("read after eof"), 0);
    }

    #[test]
    fn read_into_empty_buf_is_noop_and_keeps_session_alive() {
        // A zero-length buf reads nothing and returns Ok(0) WITHOUT meaning EOF — it must not end
        // the session, and the buffered output must remain readable.
        let factory = FakePtyFactory;
        let spec = SessionSpec::shell("/bin/sh");
        let mut session = Session::spawn(2, &factory, &spec, PtySize::default()).expect("spawn");
        session.write(b"data").expect("write");

        let mut empty: [u8; 0] = [];
        assert_eq!(session.read(&mut empty).expect("empty read"), 0);
        assert!(
            session.is_alive(),
            "empty-buf read must not end the session"
        );

        let mut buf = [0u8; 8];
        let n = session.read(&mut buf).expect("read");
        assert_eq!(&buf[..n], b"data");
    }

    #[test]
    fn process_id_passes_through_the_backend() {
        // The fake has no real child, so it reports None; a real platform backend reports Some(pid).
        let factory = FakePtyFactory;
        let spec = SessionSpec::shell("/bin/sh");
        let session = Session::spawn(3, &factory, &spec, PtySize::default()).expect("spawn");
        assert_eq!(session.process_id(), None);
    }
}
