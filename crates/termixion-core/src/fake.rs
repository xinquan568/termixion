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

use crate::pty::{PtyBackend, PtyError, PtyFactory, PtySize, SessionSpec};

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
}
