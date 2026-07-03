// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! The reader pump (trmx-74): the loop that moves PTY output to a transport until the stream ends
//! — extracted from the shell so the seam behavior "shell exit closes exactly the owning tab" is
//! unit-testable headless (R8). Pure over core types: the shell calls this on its dedicated
//! thread with `send = channel.send(...)` and `on_exit = registry.close(id) + emit pty:exited`.

use crate::pty::PtyReader;

/// Forward chunks from `reader` into `send` until EOF (`Ok(0)`), a read error, or `send`
/// returning `false` (the transport is gone); then invoke `on_exit` exactly once.
///
/// `send` receives each chunk in order and returns whether the transport accepted it.
pub fn pump<S, E>(mut reader: Box<dyn PtyReader>, mut send: S, on_exit: E)
where
    S: FnMut(&[u8]) -> bool,
    E: FnOnce(),
{
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break, // EOF (child exited) or read error → stream over
            Ok(n) => {
                if !send(&buf[..n]) {
                    break; // transport gone (webview/channel closed)
                }
            }
        }
    }
    on_exit();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::{PtyError, PtySize};
    use std::cell::Cell;

    use crate::fake::SeparableFakePtyBackend;
    use crate::pty::PtyBackend;

    /// A reader that errors on first read — the read-error exit path.
    struct ErroringReader;
    impl PtyReader for ErroringReader {
        fn read(&mut self, _buf: &mut [u8]) -> Result<usize, PtyError> {
            Err(PtyError::Io("boom".into()))
        }
    }

    fn separable_with_output(chunks: &[&[u8]]) -> Box<dyn PtyReader> {
        let mut backend = SeparableFakePtyBackend::new(PtySize::default());
        let reader = backend.take_reader().expect("reader");
        for chunk in chunks {
            backend.write(chunk).expect("write");
        }
        backend.kill().expect("kill → EOF after drain");
        reader
    }

    #[test]
    fn forwards_chunks_in_order_then_calls_on_exit_once_at_eof() {
        let reader = separable_with_output(&[b"ab", b"cd"]);
        let mut seen: Vec<u8> = Vec::new();
        let exits = Cell::new(0u32);
        pump(
            reader,
            |chunk| {
                seen.extend_from_slice(chunk);
                true
            },
            || exits.set(exits.get() + 1),
        );
        assert_eq!(seen, b"abcd");
        assert_eq!(exits.get(), 1, "on_exit fires exactly once");
    }

    #[test]
    fn read_error_still_reaches_on_exit() {
        let exits = Cell::new(0u32);
        pump(
            Box::new(ErroringReader),
            |_| true,
            || exits.set(exits.get() + 1),
        );
        assert_eq!(exits.get(), 1);
    }

    #[test]
    fn rejected_send_stops_pumping_and_reaches_on_exit() {
        let reader = separable_with_output(&[b"first", b"second"]);
        let mut sends = 0u32;
        let exits = Cell::new(0u32);
        pump(
            reader,
            |_chunk| {
                sends += 1;
                false // transport gone on the first chunk
            },
            || exits.set(exits.get() + 1),
        );
        assert_eq!(sends, 1, "no further sends after rejection");
        assert_eq!(exits.get(), 1);
    }
}
