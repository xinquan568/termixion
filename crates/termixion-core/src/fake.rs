// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! An in-memory [`PtyBackend`] for headless tests and downstream crates — no real process and no
//! platform code, so the whole core (and anything that drives it) is testable on Linux CI.
//!
//! Bytes written are echoed back into the read buffer (a loopback), so a session can be exercised
//! end-to-end without a terminal. Per the [`PtyBackend::read`] contract, `read` returns `Ok(0)` =
//! **EOF** once the echo buffer is drained — the loopback has no concurrent writer, so "drained"
//! is its end-of-stream. Tests therefore read right after writing (as a real UI loop does).

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};

use crate::pty::{PtyBackend, PtyError, PtyFactory, PtyReader, PtySize, SessionSpec};

/// An in-memory PTY: bytes written are queued to be read back (loopback "echo").
pub struct FakePtyBackend {
    buffer: VecDeque<u8>,
    size: PtySize,
    alive: bool,
}

impl FakePtyBackend {
    /// A fresh, alive loopback backend at `size`.
    pub fn new(size: PtySize) -> Self {
        Self {
            buffer: VecDeque::new(),
            size,
            alive: true,
        }
    }

    /// The most recent size set via [`PtyBackend::resize`] (handy for assertions).
    pub fn size(&self) -> PtySize {
        self.size
    }
}

impl PtyBackend for FakePtyBackend {
    fn write(&mut self, data: &[u8]) -> Result<usize, PtyError> {
        if !self.alive {
            return Err(PtyError::NotRunning);
        }
        self.buffer.extend(data.iter().copied());
        Ok(data.len())
    }

    fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError> {
        let mut read = 0;
        while read < buf.len() {
            match self.buffer.pop_front() {
                Some(byte) => {
                    buf[read] = byte;
                    read += 1;
                }
                None => break,
            }
        }
        Ok(read)
    }

    fn resize(&mut self, size: PtySize) -> Result<(), PtyError> {
        if !self.alive {
            return Err(PtyError::NotRunning);
        }
        self.size = size;
        Ok(())
    }

    fn kill(&mut self) -> Result<(), PtyError> {
        self.alive = false;
        Ok(())
    }
}

/// A [`PtyFactory`] that produces [`FakePtyBackend`]s — for headless tests.
#[derive(Debug, Default)]
pub struct FakePtyFactory;

impl PtyFactory for FakePtyFactory {
    fn spawn(&self, _spec: &SessionSpec, size: PtySize) -> Result<Box<dyn PtyBackend>, PtyError> {
        Ok(Box::new(FakePtyBackend::new(size)))
    }
}

impl FakePtyFactory {
    /// The reader-capable counterpart (the trmx-74 plan's named entry point): a factory whose
    /// backends split off a real [`PtyReader`] via `take_reader`. Returns the distinct
    /// [`SeparableFakePtyFactory`] type rather than mutating this one, so the plain fake's
    /// "no separable reader" contract (pinned by session tests) can never change under a caller.
    pub fn with_separable_reader() -> SeparableFakePtyFactory {
        SeparableFakePtyFactory
    }
}

// ---------------------------------------------------------------------------------------------
// Separable-reader fake (trmx-74). The plain fake above deliberately has NO separable reader
// (`take_reader` → `None`) so the spawn-refuses-cleanly path stays testable. The types below are
// the opt-in counterpart: the same loopback, but `take_reader` splits off a real [`PtyReader`]
// so registry/pump behavior (reader hand-off, EOF-after-kill, chunk forwarding) is testable
// headless. Contract: bytes written to the backend are readable via the reader; after `kill`,
// pending bytes drain first and then `read` returns `Ok(0)` (EOF) — matching a real PTY, where
// buffered output survives the child's death.
// ---------------------------------------------------------------------------------------------

/// State shared between a [`SeparableFakePtyBackend`] and its split-off [`FakePtyReader`].
struct SharedLoopback {
    buffer: VecDeque<u8>,
    alive: bool,
}

/// The loopback halves share the buffer under one lock; the condvar wakes a blocked reader on
/// every write and on kill (EOF).
struct LoopbackShared {
    state: Mutex<SharedLoopback>,
    wake: Condvar,
}

/// An in-memory PTY whose output half can be split off via [`PtyBackend::take_reader`].
pub struct SeparableFakePtyBackend {
    shared: Arc<LoopbackShared>,
    size: PtySize,
    reader_taken: bool,
}

impl SeparableFakePtyBackend {
    /// A fresh, alive separable loopback at `size`.
    pub fn new(size: PtySize) -> Self {
        Self {
            shared: Arc::new(LoopbackShared {
                state: Mutex::new(SharedLoopback {
                    buffer: VecDeque::new(),
                    alive: true,
                }),
                wake: Condvar::new(),
            }),
            size,
            reader_taken: false,
        }
    }
}

impl PtyBackend for SeparableFakePtyBackend {
    fn write(&mut self, data: &[u8]) -> Result<usize, PtyError> {
        let Ok(mut state) = self.shared.state.lock() else {
            return Err(PtyError::Io("fake loopback lock poisoned".into()));
        };
        if !state.alive {
            return Err(PtyError::NotRunning);
        }
        state.buffer.extend(data.iter().copied());
        self.shared.wake.notify_all();
        Ok(data.len())
    }

    fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError> {
        // Once the reader is taken it owns the output; the backend yields nothing (trait contract).
        if self.reader_taken || buf.is_empty() {
            return Ok(0);
        }
        let Ok(mut state) = self.shared.state.lock() else {
            return Err(PtyError::Io("fake loopback lock poisoned".into()));
        };
        let mut read = 0;
        while read < buf.len() {
            match state.buffer.pop_front() {
                Some(byte) => {
                    buf[read] = byte;
                    read += 1;
                }
                None => break,
            }
        }
        Ok(read)
    }

    fn resize(&mut self, size: PtySize) -> Result<(), PtyError> {
        let Ok(state) = self.shared.state.lock() else {
            return Err(PtyError::Io("fake loopback lock poisoned".into()));
        };
        if !state.alive {
            return Err(PtyError::NotRunning);
        }
        self.size = size;
        Ok(())
    }

    fn kill(&mut self) -> Result<(), PtyError> {
        let Ok(mut state) = self.shared.state.lock() else {
            return Err(PtyError::Io("fake loopback lock poisoned".into()));
        };
        state.alive = false;
        // Wake any blocked reader so it can observe EOF.
        self.shared.wake.notify_all();
        Ok(())
    }

    fn take_reader(&mut self) -> Option<Box<dyn PtyReader>> {
        if self.reader_taken {
            return None;
        }
        self.reader_taken = true;
        Some(Box::new(FakePtyReader {
            shared: Arc::clone(&self.shared),
        }))
    }
}

/// The split-off output half of a [`SeparableFakePtyBackend`]: drains echoed bytes, blocks while
/// the loopback is alive-but-empty, and returns `Ok(0)` (EOF) once killed and drained.
pub struct FakePtyReader {
    shared: Arc<LoopbackShared>,
}

impl PtyReader for FakePtyReader {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError> {
        if buf.is_empty() {
            return Ok(0);
        }
        let Ok(mut state) = self.shared.state.lock() else {
            return Err(PtyError::Io("fake loopback lock poisoned".into()));
        };
        loop {
            if !state.buffer.is_empty() {
                let mut read = 0;
                while read < buf.len() {
                    match state.buffer.pop_front() {
                        Some(byte) => {
                            buf[read] = byte;
                            read += 1;
                        }
                        None => break,
                    }
                }
                return Ok(read);
            }
            if !state.alive {
                return Ok(0); // EOF: killed and drained.
            }
            state = match self.shared.wake.wait(state) {
                Ok(guard) => guard,
                Err(_) => return Err(PtyError::Io("fake loopback lock poisoned".into())),
            };
        }
    }
}

/// A [`PtyFactory`] producing [`SeparableFakePtyBackend`]s — the reader-capable fake for
/// registry/pump tests. The plain [`FakePtyFactory`] stays reader-less by design.
#[derive(Debug, Default)]
pub struct SeparableFakePtyFactory;

impl PtyFactory for SeparableFakePtyFactory {
    fn spawn(&self, _spec: &SessionSpec, size: PtySize) -> Result<Box<dyn PtyBackend>, PtyError> {
        Ok(Box::new(SeparableFakePtyBackend::new(size)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_read_back() {
        let mut backend = FakePtyBackend::new(PtySize::default());
        assert_eq!(backend.write(b"abc").expect("write"), 3);
        let mut buf = [0u8; 8];
        assert_eq!(backend.read(&mut buf).expect("read"), 3);
        assert_eq!(&buf[..3], b"abc");
        // nothing left to read.
        assert_eq!(backend.read(&mut buf).expect("read empty"), 0);
    }

    #[test]
    fn resize_then_kill() {
        let mut backend = FakePtyBackend::new(PtySize::default());
        backend.resize(PtySize::new(10, 30)).expect("resize");
        assert_eq!(backend.size(), PtySize::new(10, 30));
        backend.kill().expect("kill");
        assert!(matches!(backend.write(b"x"), Err(PtyError::NotRunning)));
        assert!(matches!(
            backend.resize(PtySize::default()),
            Err(PtyError::NotRunning)
        ));
    }

    #[test]
    fn read_into_empty_buf_reads_nothing() {
        // A zero-length buf must read nothing and leave queued bytes untouched.
        let mut backend = FakePtyBackend::new(PtySize::default());
        backend.write(b"x").expect("write");
        let mut empty: [u8; 0] = [];
        assert_eq!(backend.read(&mut empty).expect("read empty"), 0);
        // The byte is still queued.
        let mut buf = [0u8; 1];
        assert_eq!(backend.read(&mut buf).expect("read"), 1);
        assert_eq!(buf[0], b'x');
    }

    #[test]
    fn factory_spawns_at_size() {
        let factory = FakePtyFactory;
        let spec = SessionSpec::shell("/bin/sh");
        let mut backend = factory
            .spawn(&spec, PtySize::new(50, 100))
            .expect("factory spawn");
        // round-trip a byte to prove it is a live loopback.
        assert_eq!(backend.write(b"z").expect("write"), 1);
        let mut buf = [0u8; 1];
        assert_eq!(backend.read(&mut buf).expect("read"), 1);
        assert_eq!(buf[0], b'z');
    }

    // --- separable-reader fake (trmx-74) ---

    #[test]
    fn separable_reader_receives_echoed_writes() {
        let mut backend = SeparableFakePtyBackend::new(PtySize::default());
        let mut reader = backend.take_reader().expect("reader available");
        backend.write(b"hello").expect("write");
        let mut buf = [0u8; 16];
        assert_eq!(reader.read(&mut buf).expect("read"), 5);
        assert_eq!(&buf[..5], b"hello");
    }

    #[test]
    fn separable_reader_is_once_only_and_backend_read_yields_nothing_after_take() {
        let mut backend = SeparableFakePtyBackend::new(PtySize::default());
        assert!(backend.take_reader().is_some());
        assert!(backend.take_reader().is_none(), "reader is once-only");
        backend.write(b"x").expect("write");
        let mut buf = [0u8; 4];
        // The reader owns the output now; the backend's own read yields nothing.
        assert_eq!(backend.read(&mut buf).expect("backend read"), 0);
    }

    #[test]
    fn separable_reader_drains_pending_bytes_then_reports_eof_after_kill() {
        let mut backend = SeparableFakePtyBackend::new(PtySize::default());
        let mut reader = backend.take_reader().expect("reader");
        backend.write(b"tail").expect("write");
        backend.kill().expect("kill");
        let mut buf = [0u8; 16];
        // Buffered output survives the kill (like a real PTY), THEN EOF.
        assert_eq!(reader.read(&mut buf).expect("drain"), 4);
        assert_eq!(&buf[..4], b"tail");
        assert_eq!(reader.read(&mut buf).expect("eof"), 0);
        // EOF is sticky.
        assert_eq!(reader.read(&mut buf).expect("eof again"), 0);
    }

    #[test]
    fn separable_reader_blocks_until_a_cross_thread_write_arrives() {
        // The reader must BLOCK while alive-but-empty (never Ok(0) = false EOF): read on a second
        // thread, write from this one, and require the echoed byte to come back.
        let mut backend = SeparableFakePtyBackend::new(PtySize::default());
        let mut reader = backend.take_reader().expect("reader");
        let handle = std::thread::spawn(move || {
            let mut buf = [0u8; 4];
            let n = reader.read(&mut buf).expect("blocking read");
            (n, buf)
        });
        // Give the reader a moment to enter its wait; then write.
        std::thread::sleep(std::time::Duration::from_millis(50));
        backend.write(b"w").expect("write");
        let (n, buf) = handle.join().expect("join");
        assert_eq!(n, 1);
        assert_eq!(buf[0], b'w');
    }

    #[test]
    fn separable_factory_spawns_reader_capable_backends() {
        let factory = SeparableFakePtyFactory;
        let spec = SessionSpec::shell("/bin/sh");
        let mut backend = factory.spawn(&spec, PtySize::default()).expect("spawn");
        assert!(backend.take_reader().is_some());
    }

    #[test]
    fn with_separable_reader_is_the_named_route_to_the_reader_capable_factory() {
        // The plan-named constructor and the direct type produce equivalent factories.
        let factory = FakePtyFactory::with_separable_reader();
        let spec = SessionSpec::shell("/bin/sh");
        let mut backend = factory.spawn(&spec, PtySize::default()).expect("spawn");
        assert!(backend.take_reader().is_some());
    }
}
