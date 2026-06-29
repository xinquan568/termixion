// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! macOS implementations of the `termixion-core` seam — the PTY backend (via `portable-pty`) and a
//! clipboard stub. This whole module is `cfg(target_os = "macos")`; platform code lives here, never
//! in `termixion-core` (R1/R2).

use std::io::{Read, Write};

use portable_pty::{Child, CommandBuilder, MasterPty, native_pty_system};
use termixion_core::{PtyBackend, PtyError, PtyFactory, PtyReader, PtySize, SessionSpec};

/// Map the core's terminal size onto `portable-pty`'s (pixel dimensions are unused for v0.0.1).
fn to_pp_size(size: PtySize) -> portable_pty::PtySize {
    portable_pty::PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// A live macOS PTY session: the master end (for resize), its reader/writer, and the child process.
/// `reader` is an `Option` because [`PtyBackend::take_reader`] can move it onto a dedicated read
/// thread (ADR-0001); once taken, the backend reads no output (the [`MacosPtyReader`] does).
struct MacosPtyBackend {
    master: Box<dyn MasterPty + Send>,
    reader: Option<Box<dyn Read + Send>>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// The blocking output half of a macOS PTY, moved onto its own thread for streaming. It holds only the
/// reader, so EOF here cannot reap the child — the control side (`kill`/`Drop` on the backend) does.
struct MacosPtyReader {
    reader: Box<dyn Read + Send>,
}

impl PtyReader for MacosPtyReader {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError> {
        self.reader
            .read(buf)
            .map_err(|e| PtyError::Io(e.to_string()))
    }
}

impl PtyBackend for MacosPtyBackend {
    fn write(&mut self, data: &[u8]) -> Result<usize, PtyError> {
        // write_all (not a single write) so a partial write never silently drops keystrokes — the
        // whole buffer is delivered or it errors.
        self.writer
            .write_all(data)
            .map_err(|e| PtyError::Io(e.to_string()))?;
        // Flush so keystrokes reach the child immediately (no buffering latency).
        self.writer
            .flush()
            .map_err(|e| PtyError::Io(e.to_string()))?;
        Ok(data.len())
    }

    fn read(&mut self, buf: &mut [u8]) -> Result<usize, PtyError> {
        // Blocking read; `Ok(0)` is EOF (the slave end has closed and the child exited), per the
        // `PtyBackend::read` contract. Once the reader has been taken (streaming thread owns it), the
        // backend yields no output.
        let Some(reader) = self.reader.as_mut() else {
            return Ok(0);
        };
        let read = reader.read(buf).map_err(|e| PtyError::Io(e.to_string()))?;
        if read == 0 {
            // EOF — the child has exited; reap it so it does not linger as a zombie.
            let _ = self.child.wait();
        }
        Ok(read)
    }

    fn resize(&mut self, size: PtySize) -> Result<(), PtyError> {
        self.master
            .resize(to_pp_size(size))
            .map_err(|e| PtyError::Io(e.to_string()))
    }

    fn kill(&mut self) -> Result<(), PtyError> {
        // Idempotent: if the child has already exited, reap and return.
        match self.child.try_wait() {
            Ok(Some(_status)) => return Ok(()),
            Ok(None) => {}
            Err(e) => return Err(PtyError::Io(e.to_string())),
        }
        self.child.kill().map_err(|e| PtyError::Io(e.to_string()))?;
        // Reap so the killed child does not become a zombie.
        self.child.wait().map_err(|e| PtyError::Io(e.to_string()))?;
        Ok(())
    }

    fn process_id(&self) -> Option<u32> {
        self.child.process_id()
    }

    fn take_reader(&mut self) -> Option<Box<dyn PtyReader>> {
        self.reader
            .take()
            .map(|reader| Box::new(MacosPtyReader { reader }) as Box<dyn PtyReader>)
    }
}

impl Drop for MacosPtyBackend {
    fn drop(&mut self) {
        // Best-effort reaping so a dropped session never leaves a zombie: if the child already
        // exited, reap it; otherwise kill and reap.
        if let Ok(Some(_status)) = self.child.try_wait() {
            return;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Spawns PTY-backed sessions on macOS via `portable-pty`.
#[derive(Debug, Default)]
pub struct MacosPtyFactory;

impl PtyFactory for MacosPtyFactory {
    fn spawn(&self, spec: &SessionSpec, size: PtySize) -> Result<Box<dyn PtyBackend>, PtyError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(to_pp_size(size))
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        // Build the command from the spec — OsString/PathBuf map straight onto CommandBuilder.
        let mut cmd = CommandBuilder::new(spec.program.clone());
        cmd.args(&spec.args);
        // Honor the core contract: `cwd == None` inherits the *parent's* working directory.
        // portable-pty otherwise defaults an unset cwd to $HOME, so set it explicitly; and validate
        // an explicit cwd is a real directory (portable-pty would silently fall back to $HOME).
        match &spec.cwd {
            Some(cwd) => {
                if !cwd.is_dir() {
                    return Err(PtyError::Spawn(format!(
                        "cwd is not a directory: {}",
                        cwd.display()
                    )));
                }
                cmd.cwd(cwd.as_os_str());
            }
            None => {
                let inherited =
                    std::env::current_dir().map_err(|e| PtyError::Spawn(e.to_string()))?;
                cmd.cwd(inherited.as_os_str());
            }
        }
        for (key, val) in &spec.env {
            cmd.env(key, val);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        // Drop our handle to the slave so the master `read` reports EOF once the child exits.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::Spawn(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        Ok(Box::new(MacosPtyBackend {
            master: pair.master,
            reader: Some(reader),
            writer,
            child,
        }))
    }
}

/// Read/write the system clipboard. The seam for auto-copy-on-select (FR-8) and paste.
pub trait Clipboard {
    /// The current clipboard text.
    fn get_text(&self) -> std::io::Result<String>;
    /// Replace the clipboard text.
    fn set_text(&self, text: &str) -> std::io::Result<()>;
}

/// macOS clipboard — a **stub** for v0.0.1. The real implementation (NSPasteboard) lands with the
/// clipboard / auto-copy work (P1-7 / Beta); until then it reports `Unsupported`.
#[derive(Debug, Default)]
pub struct MacosClipboard;

impl Clipboard for MacosClipboard {
    fn get_text(&self) -> std::io::Result<String> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "macOS clipboard not yet implemented (P1-7)",
        ))
    }

    fn set_text(&self, _text: &str) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "macOS clipboard not yet implemented (P1-7)",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use termixion_core::{PtyBackend, PtyFactory, PtySize, SessionSpec};

    /// Read a real backend to EOF and return its output as a lossy String.
    fn drain(backend: &mut dyn PtyBackend) -> String {
        let mut out = Vec::new();
        let mut buf = [0u8; 256];
        loop {
            match backend.read(&mut buf).expect("read should succeed") {
                0 => break, // EOF — the child exited
                n => out.extend_from_slice(&buf[..n]),
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    /// Golden test: spawn a real `/bin/echo` through a real PTY and read its output back.
    #[test]
    fn echo_roundtrips_through_real_pty() {
        let factory = MacosPtyFactory;
        let mut spec = SessionSpec::shell("/bin/echo");
        spec.args.push("termixion-pty-ok".into());

        let mut backend = factory
            .spawn(&spec, PtySize::new(24, 80))
            .expect("spawn should succeed");

        let text = drain(&mut *backend);
        assert!(
            text.contains("termixion-pty-ok"),
            "expected the marker in the pty output, got: {text:?}"
        );
    }

    #[test]
    fn write_reaches_child_and_reads_back() {
        // A shell reads one line and prints it with a "GOT:" prefix, then exits. The prefix can only
        // come from the *child* (terminal ECHO would only ever show the raw lowercase input), and the
        // child exiting yields EOF so the read loop terminates — proving the full
        // write -> child -> read round-trip rather than line-discipline echo.
        let factory = MacosPtyFactory;
        let mut spec = SessionSpec::shell("/bin/sh");
        spec.args.push("-c".into());
        spec.args
            .push("read line; printf 'GOT:%s\\n' \"$line\"".into());
        let mut backend = factory
            .spawn(&spec, PtySize::new(24, 80))
            .expect("spawn sh");

        backend.write(b"hello-termixion\n").expect("write");

        let acc = drain(&mut *backend);
        assert!(
            acc.contains("GOT:hello-termixion"),
            "child did not process the input; got: {acc:?}"
        );
    }

    #[test]
    fn resize_and_kill_are_well_behaved() {
        // `cat` blocks reading stdin, so it stays alive — exercising kill() on a *live* child (and
        // its reap), then idempotent kill. No read (which would just see terminal echo).
        let factory = MacosPtyFactory;
        let spec = SessionSpec::shell("/bin/cat");
        let mut backend = factory
            .spawn(&spec, PtySize::new(24, 80))
            .expect("spawn cat");

        backend.resize(PtySize::new(40, 120)).expect("resize");
        backend.kill().expect("kill (live child)");
        backend.kill().expect("kill is idempotent");
    }

    #[test]
    fn clipboard_stub_is_unsupported() {
        let clip = MacosClipboard;
        assert!(clip.get_text().is_err());
        assert!(clip.set_text("x").is_err());
    }

    /// An explicit cwd that is not a real directory is rejected with `Spawn` — we validate it
    /// ourselves because portable-pty would otherwise silently fall back to $HOME.
    #[test]
    fn invalid_cwd_is_rejected() {
        // A unique path under temp_dir that we ensure does not exist — don't depend on any
        // particular absolute path being absent on the host.
        let missing =
            std::env::temp_dir().join(format!("termixion-missing-{}", std::process::id()));
        std::fs::remove_dir_all(&missing).ok();
        assert!(!missing.exists(), "test cwd must not exist");

        let factory = MacosPtyFactory;
        let mut spec = SessionSpec::shell("/bin/echo");
        spec.cwd = Some(missing);

        // Box<dyn PtyBackend> isn't Debug, so let-else out the error rather than `expect_err`.
        let Err(err) = factory.spawn(&spec, PtySize::new(24, 80)) else {
            panic!("a non-directory cwd must fail, but spawn succeeded");
        };
        assert!(
            matches!(&err, PtyError::Spawn(msg) if msg.contains("not a directory")),
            "expected a Spawn 'not a directory' error, got: {err:?}"
        );
    }

    /// A valid explicit cwd is honored: the child actually runs there. We assert on the *final path
    /// component* of `pwd`'s output (not the full path), so macOS symlink resolution
    /// (/var -> /private/var) can't break the match while still proving pwd ended in our directory.
    #[test]
    fn explicit_cwd_is_honored_by_child() {
        let leaf = format!("termixion-cwd-{}", std::process::id());
        let dir = std::env::temp_dir().join(&leaf);
        std::fs::create_dir_all(&dir).expect("mkdir test cwd");

        let factory = MacosPtyFactory;
        let mut spec = SessionSpec::shell("/bin/pwd");
        spec.cwd = Some(dir.clone());
        let mut backend = factory
            .spawn(&spec, PtySize::new(24, 80))
            .expect("spawn pwd");

        let out = drain(&mut *backend);
        std::fs::remove_dir_all(&dir).ok();
        // pwd prints one absolute path (the PTY adds a trailing \r\n); its last component is the cwd.
        let reported = out.trim().rsplit('/').next().unwrap_or("");
        assert_eq!(
            reported, leaf,
            "pwd should end in the spawn cwd ({leaf}); got: {out:?}"
        );
    }

    /// Extra environment from the spec is *layered onto* (not replacing) the inherited environment:
    /// the spec's variable reaches the child AND an inherited variable (`PATH`) is still visible.
    #[test]
    fn spec_env_is_layered_onto_child() {
        // A process-unique var name, asserted absent from the parent env, so the value the child
        // prints can ONLY have come from spec.env (not an inherited variable).
        let var = format!("TERMIXION_TEST_VAR_{}", std::process::id());
        assert!(
            std::env::var_os(&var).is_none(),
            "parent env must not already define {var}"
        );

        let factory = MacosPtyFactory;
        let mut spec = SessionSpec::shell("/bin/sh");
        spec.args.push("-c".into());
        // ENV: proves the spec var arrived; PATH: present proves inherited env survived the layering.
        spec.args
            .push(format!("printf 'ENV:%s PATH:%s' \"${var}\" \"${{PATH:+present}}\"").into());
        spec.env.push((var.into(), "marker-42".into()));

        let mut backend = factory
            .spawn(&spec, PtySize::new(24, 80))
            .expect("spawn sh");
        let out = drain(&mut *backend);
        assert!(
            out.contains("ENV:marker-42"),
            "child did not see the spec env; got: {out:?}"
        );
        assert!(
            out.contains("PATH:present"),
            "inherited PATH must survive env layering; got: {out:?}"
        );
    }

    /// A login-shell spec carries `TERM` all the way to the child through a real PTY. This is the
    /// regression guard for trmx-37: a GUI launch inherits no `$TERM`, so without the spec forcing it
    /// the child shell would see an empty `TERM` (breaking `clear` and ZLE backspace/delete). We reuse
    /// `login_shell()`'s env but run a non-interactive `/bin/sh` that prints `$TERM` and exits, so the
    /// reader reaches EOF. The spec's `TERM` overrides any inherited value (portable-pty layers
    /// `cmd.env` over the inherited environment), so the assertion holds regardless of the parent's
    /// `$TERM` — including CI/GUI parents that have none.
    #[test]
    fn login_shell_term_reaches_child_through_real_pty() {
        let login = SessionSpec::login_shell();
        // Same env as the production login shell, but a child that prints $TERM and exits.
        let mut spec = SessionSpec::shell("/bin/sh");
        spec.args.push("-c".into());
        spec.args.push("printf 'TERM=[%s]' \"$TERM\"".into());
        spec.env = login.env;

        let factory = MacosPtyFactory;
        let mut backend = factory
            .spawn(&spec, PtySize::new(24, 80))
            .expect("spawn sh");
        let out = drain(&mut *backend);
        assert!(
            out.contains("TERM=[xterm-256color]"),
            "the login shell must export TERM=xterm-256color to the child; got: {out:?}"
        );
    }

    /// The split output reader (ADR-0001 streaming) reads real PTY output on its own, can only be
    /// taken once, and leaves the control side (kill) working.
    #[test]
    fn taken_reader_streams_output_and_is_taken_once() {
        let factory = MacosPtyFactory;
        let mut spec = SessionSpec::shell("/bin/echo");
        spec.args.push("termixion-reader-ok".into());
        let mut backend = factory.spawn(&spec, PtySize::new(24, 80)).expect("spawn");

        let mut reader = backend
            .take_reader()
            .expect("a real backend yields a reader");
        assert!(
            backend.take_reader().is_none(),
            "the reader can only be taken once"
        );

        let mut out = Vec::new();
        let mut buf = [0u8; 256];
        loop {
            match reader.read(&mut buf).expect("read via the split reader") {
                0 => break, // EOF
                n => out.extend_from_slice(&buf[..n]),
            }
        }
        assert!(
            String::from_utf8_lossy(&out).contains("termixion-reader-ok"),
            "the split reader should stream the child's output; got: {out:?}"
        );

        // Control side still works without the reader.
        backend.kill().expect("kill after taking the reader");
    }
}
