// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-75 (FR-2.4): resolve a shell's **foreground process** — the process-group leader that
//! currently owns the shell's controlling terminal — so the shell's title poller can hint tab
//! titles ("sleep", "vim", …) from what is actually running. Pid-in/name-out: the seam takes the
//! registry's public `process_id` and returns a display name, so `termixion-core` gains no trait
//! change and no platform code (R1/R2).
//!
//! Implementation: two `ps` subprocesses per call — `ps -o tpgid= -p <shell_pid>` yields the
//! controlling terminal's foreground process-group id, then `ps -o comm= -p <tpgid>` yields the
//! leader's command, whose basename is the name. Zero new deps, and at the poller's 1 Hz cadence
//! over a handful of sessions the subprocess cost is negligible; a `sysctl`(KERN_PROC)-based
//! resolver is the documented future optimization if that ever changes.
//!
//! **Accuracy limits.** The tpgid names the pipeline's *leader* — for `sleep 1 | cat` that is the
//! first process, so a multi-stage pipeline reports its head, not its tail. And the answer is a
//! poll-time snapshot: a process that starts and exits between polls is never observed, and a
//! reported name can lag reality by up to one poll interval. Both are acceptable for a title hint.
//!
//! **FR-7a (`v0.0.7`).** The activity indicator + "close busy tab?" confirmation define *busy* as
//! `foreground leader pid != shell pid`: [`is_busy`] is exactly that — a pure map over
//! [`foreground_process`] comparing [`ForegroundProcess::pid`] against the shell pid.
//!
//! **trmx-263 (grill A3).** The per-pid functions above cost one `ps` fork EACH, and the poller
//! called them once per session per 250 ms iteration (plus two per session on every 4th) — 6N forks
//! per four-tick cycle, sequentially, so the poller's cycle stretched linearly with the pane count
//! (measured: ~7.5 ms per fork on the reference Mac; 3.6 s of resolution work per cycle at 50
//! sessions). [`foreground_leaders`] and [`process_names`] resolve MANY pids with one `ps -p a,b,c`
//! each, so the periodic cost is flat in N. The per-pid functions stay for the rise path and the
//! real-shell tests; the batched ones agree with them on the same processes (pinned in
//! `tests/foreground_batch.rs`).

use std::collections::HashMap;
use std::process::Command;

/// The foreground process-group leader on a shell's controlling terminal: its pid (the group id —
/// for a single-process job, the process itself) and its display name (the basename of `comm`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForegroundProcess {
    pub pid: u32,
    pub name: String,
}

/// Resolve the foreground process on `shell_pid`'s controlling terminal, or `None` when it cannot
/// be determined (the pid is gone, has no controlling terminal / no foreground group — `tpgid`
/// `-1` — or `ps` itself fails). Best-effort by design: a `None` tick simply yields no title hint.
pub fn foreground_process(shell_pid: u32) -> Option<ForegroundProcess> {
    let tpgid = foreground_leader_pid(shell_pid)?;
    let comm_raw = ps_column("comm=", tpgid)?;
    let name = parse_comm(&comm_raw)?;
    Some(ForegroundProcess { pid: tpgid, name })
}

/// The foreground process-group id on `shell_pid`'s controlling terminal (the `tpgid`), or `None`
/// when it cannot be determined (`-1`/`0`/junk, or `ps` fails). ONE `ps -o tpgid=` — the cheap
/// tcgetpgrp-equivalent the FR-7a busy predicate ([`is_busy`]) polls at 250 ms; it deliberately does
/// NOT resolve the leader's command name (that second `ps` is only for title hints), so it stays a
/// single subprocess AND stays correct when the group leader has exited but the group is still
/// foregrounding (a pipeline like `true | sleep 5` — the leader `true` is gone but the group runs).
fn foreground_leader_pid(shell_pid: u32) -> Option<u32> {
    parse_tpgid(&ps_column("tpgid=", shell_pid)?)
}

/// Is the shell **busy** — is a foreground job *other than the shell itself* running on its
/// controlling terminal? This is the FR-7a activity-indicator / "close busy tab?" predicate: *busy*
/// ≡ the foreground process-group leader's pid **differs from the shell's own pid**. A shell sitting
/// at its prompt is its own foreground group leader ([`foreground_process`]`.pid == shell_pid`), so
/// it reads as **idle** — `Some(false)`; a running job such as `sleep` forks a child that an
/// interactive (job-control) shell moves into the terminal's foreground group, so the leader's pid
/// differs from the shell's and it reads as **busy** — `Some(true)`.
///
/// `None` when the foreground leader cannot be determined at all — the shell pid is gone, or it has
/// no controlling terminal / no foreground group, or `ps` fails; a caller treats `None` as "unknown —
/// do not gate on it". Uses only [`foreground_leader_pid`] (one cheap `ps -o tpgid=`), NOT the full
/// [`foreground_process`] — so (review-1) it stays a single subprocess at 250 ms AND reports busy for
/// a pipeline whose group leader has already exited (`true | sleep 5`): the name lookup that
/// `foreground_process` needs would fail there, but the tpgid comparison does not. Platform-only (R1/R2).
pub fn is_busy(shell_pid: u32) -> Option<bool> {
    foreground_leader_pid(shell_pid).map(|leader| leader != shell_pid)
}

// ============================================================================================
// trmx-159 (T1): richer foreground metadata for the activity indicator — the argv TAIL of a job
// (so a tab can hint "sleep 30", not just "sleep") and whether the job's stdin is a real terminal
// (so a job reading a redirected/piped stdin can be distinguished from one at the pty). Both take
// an ARBITRARY pid — the caller passes the foreground LEADER pid, not the shell pid. macOS uses the
// proc/sysctl APIs `ps` can't express cross-process; other unix (Linux CI) gets `None` stubs so the
// workspace still builds. Kept behind the platform seam (R1/R2) with narrow, commented `unsafe`.
// ============================================================================================

/// The argv TAIL (`argv[1..]`, argv[0] EXCLUDED) of process `pid`, capped at 16 entries, via macOS
/// `KERN_PROCARGS2`. `None` on any failure (pid gone, sysctl error, malformed buffer, `argc <= 0`).
/// The tab-title poller uses it to enrich a bare command name with its operands.
#[cfg(target_os = "macos")]
pub fn foreground_args(pid: u32) -> Option<Vec<String>> {
    parse_kern_procargs2(&kern_procargs2(pid)?)
}

/// Non-macOS unix stub: `KERN_PROCARGS2` is a Darwin sysctl, so the argv tail is simply unavailable
/// (Linux CI builds this arm). Returns `None` for every pid.
#[cfg(not(target_os = "macos"))]
pub fn foreground_args(_pid: u32) -> Option<Vec<String>> {
    None
}

/// The type of process `pid`'s stdin (fd 0), via macOS `proc_pidinfo(PROC_PIDLISTFDS)` — the Darwin
/// `PROX_FDTYPE_*` value (VNODE / PIPE / SOCKET / …). `None` when the pid is gone or its fd list
/// cannot be read, or when it has no fd 0. Lets [`foreground_stdin_is_tty`] tell a determinably
/// not-a-tty fd (a pipe/socket ⇒ `Some(false)`) apart from an uninspectable pid (⇒ `None`).
#[cfg(target_os = "macos")]
fn stdin_fd_type(pid: u32) -> Option<u32> {
    const PROC_PIDLISTFDS: libc::c_int = 1;

    // `struct proc_fdinfo` from `sys/proc_info.h` (libc omits it): the fd number + its PROX_FDTYPE_*.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ProcFdInfo {
        proc_fd: i32,
        proc_fdtype: u32,
    }

    // A null buffer returns the byte length the full fd list would need — 0 / negative if the pid is
    // gone or has no readable fds. SAFETY: null buffer + 0 size is the documented "size query" call.
    let needed = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            PROC_PIDLISTFDS,
            0,
            std::ptr::null_mut(),
            0,
        )
    };
    if needed <= 0 {
        return None;
    }
    let entry = std::mem::size_of::<ProcFdInfo>();
    let count = (needed as usize) / entry;
    if count == 0 {
        return None;
    }
    let mut fds = vec![
        ProcFdInfo {
            proc_fd: 0,
            proc_fdtype: 0
        };
        count
    ];
    // SAFETY: `fds` holds exactly `needed` bytes of plain-old-data; proc_pidinfo writes at most that
    // many and returns the bytes actually written.
    let got = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr() as *mut libc::c_void,
            needed,
        )
    };
    if got <= 0 {
        return None;
    }
    let n = ((got as usize) / entry).min(fds.len());
    fds[..n]
        .iter()
        .find(|fd| fd.proc_fd == 0)
        .map(|fd| fd.proc_fdtype)
}

/// Whether `pid`'s stdin (fd 0) is a tty/pty-backed terminal. A vnode fd whose path names a tty is
/// `Some(true)`; any other determinable fd — a regular file, `/dev/null`, or a **pipe/socket** (a
/// redirect / here-string / pipeline stage) — is `Some(false)`; only a vanished / uninspectable pid,
/// or a genuine proc-API short-read on a vnode fd, is `None`. Uses `proc_pidinfo` to classify fd 0's
/// TYPE first (so a non-vnode is `Some(false)`, not `None`), then `proc_pidfdinfo` for the vnode path.
#[cfg(target_os = "macos")]
pub fn foreground_stdin_is_tty(pid: u32) -> Option<bool> {
    // libc omits these Darwin `sys/proc_info.h` items, so declare exactly what we use.
    const PROC_PIDFDVNODEPATHINFO: libc::c_int = 2;
    const PROX_FDTYPE_VNODE: u32 = 1;

    // Only a VNODE fd can be a tty; a pipe / socket / kqueue stdin is determinably NOT a tty.
    if stdin_fd_type(pid)? != PROX_FDTYPE_VNODE {
        return Some(false);
    }

    // `struct proc_fileinfo` — the fixed header that precedes the vnode info in the
    // PROC_PIDFDVNODEPATHINFO buffer. Its fields exist only to reproduce the C layout so the vnode
    // path lands at the right offset; none are read (hence `allow(dead_code)`).
    #[repr(C)]
    #[allow(dead_code)]
    struct ProcFileInfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: i64,
        fi_type: i32,
        fi_guardflags: u32,
    }

    // `struct vnode_fdinfowithpath` = a `proc_fileinfo` header followed by libc's `vnode_info_path`
    // (the vnode stat + its cached path). Layout verified against a live buffer (size 1200).
    #[repr(C)]
    struct VnodeFdInfoWithPath {
        pfi: ProcFileInfo,
        vip: libc::vnode_info_path,
    }

    let size = std::mem::size_of::<VnodeFdInfoWithPath>() as libc::c_int;
    // SAFETY: a zeroed `VnodeFdInfoWithPath` holds only plain-old-data (ints/arrays), so the
    // all-zero bit pattern is a valid value. `proc_pidfdinfo` writes at most `size` bytes into it
    // and, on success for a vnode-backed fd, returns exactly `size`; fd 0 is stdin.
    let mut info: VnodeFdInfoWithPath = unsafe { std::mem::zeroed() };
    let filled = unsafe {
        libc::proc_pidfdinfo(
            pid as libc::c_int,
            0,
            PROC_PIDFDVNODEPATHINFO,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    if filled < size {
        // fd 0 was a vnode (checked above) but the vnode-path read short-filled — a genuine failure
        // (the pid vanished between the two proc calls, or a bad buffer). Unknown ⇒ None.
        return None;
    }
    // `vst_mode` and the `S_IF*` masks are both `mode_t` (u16 on Darwin); no cast needed.
    let mode = info.vip.vip_vi.vi_stat.vst_mode;
    let is_char_device = (mode & libc::S_IFMT) == libc::S_IFCHR;
    Some(is_char_device && path_names_a_tty(&vnode_path(&info.vip)))
}

/// Non-macOS unix stub: `proc_pidfdinfo` is Darwin-only, so the stdin-tty state is unavailable.
#[cfg(not(target_os = "macos"))]
pub fn foreground_stdin_is_tty(_pid: u32) -> Option<bool> {
    None
}

/// Fetch the raw `KERN_PROCARGS2` buffer for `pid`. First reads `KERN_ARGMAX` to size a buffer,
/// then `sysctl([CTL_KERN, KERN_PROCARGS2, pid])` fills it. `None` on any sysctl failure — a pid
/// the kernel doesn't know fails the second call. Impure (the syscall); the parsing is split out.
#[cfg(target_os = "macos")]
fn kern_procargs2(pid: u32) -> Option<Vec<u8>> {
    // Size the buffer via KERN_ARGMAX — the kernel's ceiling on a process's argv+env bytes.
    let mut argmax: libc::c_int = 0;
    let mut argmax_len = std::mem::size_of::<libc::c_int>();
    let mut mib_argmax = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: a 2-element mib, writing a `c_int` (with its matching length) into `argmax`; no newp.
    let rc = unsafe {
        libc::sysctl(
            mib_argmax.as_mut_ptr(),
            mib_argmax.len() as libc::c_uint,
            &mut argmax as *mut _ as *mut libc::c_void,
            &mut argmax_len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || argmax <= 0 {
        return None;
    }

    let mut buf = vec![0u8; argmax as usize];
    let mut buf_len = buf.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    // SAFETY: a 3-element mib, writing up to `buf_len` bytes into `buf` (which is `buf_len` long);
    // `buf_len` is updated to the byte count actually written. No newp.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut buf_len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    buf.truncate(buf_len);
    Some(buf)
}

/// Parse a `KERN_PROCARGS2` buffer into the argv TAIL (`argv[1..]`), lossy UTF-8, capped at 16.
/// Layout: a leading native-endian `c_int` argc, the executable path (NUL-terminated), optional
/// padding NULs, then `argc` NUL-separated argv strings (argv[0] first). `None` on `argc <= 0`, a
/// truncated buffer (fewer strings than argc, or a missing NUL), or a buffer too short for argc.
/// Pure — unit-tested on synthetic buffers with no live process (the `parse_tpgid` pattern).
#[cfg(target_os = "macos")]
fn parse_kern_procargs2(buf: &[u8]) -> Option<Vec<String>> {
    const CAP: usize = 16;
    let argc_size = std::mem::size_of::<libc::c_int>();
    if buf.len() < argc_size {
        return None;
    }
    let argc = libc::c_int::from_ne_bytes(buf[..argc_size].try_into().ok()?);
    if argc <= 0 {
        return None;
    }
    let argc = argc as usize;
    let rest = &buf[argc_size..];

    // Skip the executable path (its own NUL-terminated string) and any alignment padding NULs.
    let exec_end = rest.iter().position(|&b| b == 0)?;
    let mut cursor = exec_end + 1;
    while cursor < rest.len() && rest[cursor] == 0 {
        cursor += 1;
    }

    // Read the `argc` argv strings; keep argv[1..], stopping at CAP. A missing terminator or a run
    // out of bytes before `argc` strings is a truncated buffer → `None` (never a partial tail).
    let mut tail: Vec<String> = Vec::new();
    for idx in 0..argc {
        if cursor > rest.len() {
            return None;
        }
        let rel = rest[cursor..].iter().position(|&b| b == 0)?;
        let end = cursor + rel;
        if idx >= 1 {
            tail.push(String::from_utf8_lossy(&rest[cursor..end]).into_owned());
            if tail.len() >= CAP {
                return Some(tail); // hit the cap — a legitimate stop, not a truncation
            }
        }
        cursor = end + 1;
    }
    Some(tail)
}

/// The NUL-terminated path out of a `vnode_info_path`, lossy UTF-8. `vip_path` is stored as
/// `[[c_char; 32]; 32]` (a MAXPATHLEN=1024 byte array libc splits to support old rustc); flatten it
/// and stop at the first NUL.
#[cfg(target_os = "macos")]
fn vnode_path(vip: &libc::vnode_info_path) -> String {
    let mut bytes: Vec<u8> = Vec::with_capacity(1024);
    for &c in vip.vip_path.iter().flatten() {
        if c == 0 {
            break;
        }
        bytes.push(c as u8);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Classify a vnode path as naming a terminal device. macOS pty slaves are `/dev/ttysNNN`, serial
/// and console ttys live under `/dev/tty…`, and the BSD legacy pty is `/dev/ptyp…`; other
/// character-special devices such as `/dev/null` must NOT match. Pure — unit-tested on canned paths.
#[cfg(target_os = "macos")]
fn path_names_a_tty(path: &str) -> bool {
    path.starts_with("/dev/tty") || path.starts_with("/dev/pty") || path == "/dev/console"
}

// ============================================================================================
// trmx-197: the interpreter-shim unwrap — resolve the EFFECTIVE foreground identity when the
// process-group leader is an interpreter fronting a CLI via a shebang shim. The npm `codex`
// launcher is `#!/usr/bin/env node` spawning the native binary as a same-group CHILD, so the
// leader's comm is `node` and the CLI's identity lives in argv[1] (the script path as execve'd).
// Pure name/argv mapping (no syscalls, no `cfg`): callers feed it `parse_comm`'s name plus
// `foreground_args`' tail and fall back to the raw name on `None`, so a missing argv (non-macOS
// stubs, a sysctl failure) degrades to today's behavior.
// ============================================================================================

/// Whether `name`'s basename is an interpreter that commonly fronts a CLI via a shebang shim:
/// exact `node` / `bun` / `deno` (case-insensitive), or the python family — `python` followed by
/// an optional version suffix of dot-separated numeric components (`python`, `python3`,
/// `python3.12`; NOT `python-config`, `pythonw`, `python.`, `python3..12`).
pub fn is_interpreter(name: &str) -> bool {
    let stripped = name.rsplit('/').next().unwrap_or(name);
    let base = stripped.to_ascii_lowercase();
    if matches!(base.as_str(), "node" | "bun" | "deno") {
        return true;
    }
    match base.strip_prefix("python") {
        Some(suffix) => suffix.is_empty() || is_dotted_numeric(suffix),
        None => false,
    }
}

/// Whether `s` is a dot-separated sequence of NON-EMPTY digit runs (`3`, `3.12`) — the python
/// version-suffix shape. Rejects a leading/trailing/doubled dot (`.`, `3.`, `3..12`).
fn is_dotted_numeric(s: &str) -> bool {
    !s.is_empty()
        && s.split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// The known script extensions a shim's basename may carry (pnpm-style shims exec the `.js`
/// directly). Stripped only when a non-empty stem remains.
const SHIM_SCRIPT_EXTENSIONS: [&str; 4] = [".js", ".mjs", ".cjs", ".py"];

/// The interpreter-shim unwrap: `Some((effective_name, effective_args))` when `name` is an
/// interpreter ([`is_interpreter`]) AND `args` (the leader's argv tail) starts with a NON-flag
/// token (the script path) — effective_name = the script's basename with one known script
/// extension stripped (`.js`/`.mjs`/`.cjs`/`.py`, only if a non-empty stem remains),
/// effective_args = `args[1..]`. `None` otherwise (identity — the caller keeps the raw name/args).
/// Conservative by construction: bare REPLs (empty tail) and flag-first forms (`node -e …`,
/// `python -m …`) never unwrap.
pub fn unwrap_interpreter_shim(name: &str, args: &[String]) -> Option<(String, Vec<String>)> {
    if !is_interpreter(name) {
        return None;
    }
    let script = args.first()?;
    if script.starts_with('-') {
        return None; // a flag-first invocation (`node -e …`, `python -m …`) is not the shim shape
    }
    let base = script.rsplit('/').next().unwrap_or(script);
    let stem = SHIM_SCRIPT_EXTENSIONS
        .iter()
        .find_map(|ext| base.strip_suffix(ext).filter(|s| !s.is_empty()))
        .unwrap_or(base);
    if stem.is_empty() {
        return None; // a trailing-slash token has no basename to name the session after
    }
    Some((stem.to_string(), args[1..].to_vec()))
}

/// One `ps -o <column> -p <pid>` invocation, as raw stdout. `None` on spawn failure or a non-zero
/// exit (macOS `ps` exits 1 for a pid it cannot find).
fn ps_column(column: &str, pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-o", column, "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Parse `ps -o tpgid=` output: a (space-padded) positive integer. `-1` (the process has no
/// controlling terminal, or its terminal has no foreground group), `0` (never a real group — pid
/// 0 is the kernel), junk, and empty all resolve to `None`. Pure — unit-tested on canned strings.
fn parse_tpgid(raw: &str) -> Option<u32> {
    raw.trim().parse::<u32>().ok().filter(|&tpgid| tpgid != 0)
}

/// Parse `ps -o comm=` output into a display name: trim, then take the basename (macOS `comm` is
/// the executable path as launched, e.g. `/bin/zsh` → `zsh`; a bare `sleep` passes through).
/// Empty output → `None`. Pure — unit-tested on canned strings.
fn parse_comm(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

// ============================================================================================
// trmx-263 (grill A3): batched resolution — one `ps -p a,b,c` for many pids. The `ps` edge is
// injectable ([`ps_rows_via`]) so a unit test can COUNT executions; the parsers are pure over the
// row shapes measured on macOS `ps` (rows sorted by pid regardless of list order; a dead pid
// silently omitted with exit 0; ALL dead → exit 1 with no rows; `comm` is the launched path and
// may contain spaces).
// ============================================================================================

/// One `ps -o pid=,tpgid= -p <pids>` for MANY shells. Map entry per pid `ps` printed a row for:
/// `Some(tpgid)` when it parses to a positive group id, `None` when the row's tpgid is `0`/`-1`
/// (no controlling terminal / no foreground group — [`is_busy`]'s `None`). A pid with NO row is
/// absent (gone). Outer `None` only when `ps` could not be spawned; an empty `shell_pids` spawns
/// nothing and returns `Some(empty)`; a list whose pids are ALL gone returns `Some(empty)` (macOS
/// `ps` exits 1 with no rows there — measured — but it RAN, which is the distinction the caller
/// needs: every session unknown this iteration, not a broken machine).
pub fn foreground_leaders(shell_pids: &[u32]) -> Option<HashMap<u32, Option<u32>>> {
    ps_rows("pid=,tpgid=", shell_pids).map(|raw| parse_leader_rows(&raw))
}

/// One `ps -o pid=,comm= -p <pids>`: pid → `comm` basename for each pid with a row (same absence
/// and outer-`None` rules as [`foreground_leaders`]). The title poller passes the DISTINCT leader
/// pids from a [`foreground_leaders`] result.
pub fn process_names(pids: &[u32]) -> Option<HashMap<u32, String>> {
    ps_rows("pid=,comm=", pids).map(|raw| parse_name_rows(&raw))
}

/// The subprocess edge for the batched functions: production runs `ps` with the argv built by
/// [`ps_rows_via`]. Unlike [`ps_column`], a non-zero exit is NOT a failure — for a list it means
/// "some (or all) of these pids are gone", and the rows that were printed are still the answer.
fn spawn_ps(argv: &[String]) -> Option<String> {
    let out = Command::new("ps").args(argv).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// One `ps -o <columns> -p a,b,c` over a de-duplicated, sorted pid list (`ps` collapses duplicates
/// and sorts its output anyway; sorting the input makes the argv deterministic for the tests).
/// Empty list → `Some(String::new())` without spawning. Argument length is ~6 bytes per pid and
/// is not chunked: a thousand sessions is ~6 KB against a 1 MiB `ARG_MAX`.
fn ps_rows(columns: &str, pids: &[u32]) -> Option<String> {
    ps_rows_via(spawn_ps, columns, pids)
}

/// [`ps_rows`] with the runner injected: `run` receives the exact argv
/// (`["-o", <columns>, "-p", "a,b,c"]`) and returns the raw stdout whenever `ps` RAN (any exit
/// code), `None` on spawn failure. The seam exists so a test can prove one non-empty call executes
/// `ps` exactly once and an empty list never does.
fn ps_rows_via<F: FnOnce(&[String]) -> Option<String>>(
    run: F,
    columns: &str,
    pids: &[u32],
) -> Option<String> {
    let mut sorted: Vec<u32> = pids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.is_empty() {
        return Some(String::new());
    }
    let list = sorted
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    run(&[
        "-o".to_string(),
        columns.to_string(),
        "-p".to_string(),
        list,
    ])
}

/// Parse `ps -o pid=,tpgid=` rows: `"  123   456"` → `123: Some(456)`; a tpgid of `0`/`-1` (or
/// anything that is not a positive integer) → `123: None`; a line whose first token is not a pid
/// (a header, junk, a blank line) is skipped. Keyed by the pid COLUMN, never by position: `ps`
/// sorts rows by pid and omits dead ones. Pure — unit-tested on canned strings.
fn parse_leader_rows(raw: &str) -> HashMap<u32, Option<u32>> {
    raw.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let tpgid = fields.next()?;
            let leader = tpgid
                .parse::<i64>()
                .ok()
                .filter(|t| *t > 0)
                .and_then(|t| u32::try_from(t).ok());
            Some((pid, leader))
        })
        .collect()
}

/// Parse `ps -o pid=,comm=` rows: the first token is the pid, EVERYTHING after it is `comm` (the
/// launched path, which may contain spaces — `/Applications/Visual Studio Code.app/…/Code Helper`),
/// reduced to its basename by [`parse_comm`]; a row with an empty name, or a non-pid first token,
/// is skipped. Pure — unit-tested on canned strings.
fn parse_name_rows(raw: &str) -> HashMap<u32, String> {
    raw.lines()
        .filter_map(|line| {
            let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
            let pid = pid.parse::<u32>().ok()?;
            let name = parse_comm(rest)?;
            Some((pid, name))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tpgid_accepts_a_padded_id_and_rejects_no_terminal_junk_and_empty() {
        // Happy paths: macOS `ps` right-pads numeric columns and appends a newline.
        assert_eq!(parse_tpgid("  1234\n"), Some(1234));
        assert_eq!(parse_tpgid("1\n"), Some(1));
        // `-1` is ps's "no controlling terminal / no foreground group" marker — not a pid.
        assert_eq!(parse_tpgid("   -1\n"), None);
        // Junk, empty, and whitespace-only outputs must never yield a group id.
        assert_eq!(parse_tpgid("junk"), None);
        assert_eq!(parse_tpgid(""), None);
        assert_eq!(parse_tpgid("   \n"), None);
        // Pid 0 is the kernel, never a foreground group.
        assert_eq!(parse_tpgid("0\n"), None);
    }

    #[test]
    fn parse_comm_yields_the_basename_and_rejects_empty() {
        // macOS `comm` is usually the executable path — the tab hint wants only the basename.
        assert_eq!(parse_comm("/bin/zsh\n"), Some("zsh".to_string()));
        assert_eq!(
            parse_comm("  /usr/local/bin/nvim  \n"),
            Some("nvim".to_string())
        );
        // A bare name (how a shell-spawned job often reports) passes through unchanged.
        assert_eq!(parse_comm("sleep\n"), Some("sleep".to_string()));
        // Empty / whitespace-only output must never become a title hint.
        assert_eq!(parse_comm(""), None);
        assert_eq!(parse_comm("   \n"), None);
    }

    /// FR-7a: with no foreground group to compare the shell pid against, `is_busy` must resolve to
    /// `None` — never a spurious `Some`, never a panic (it is a pure map over `foreground_process`,
    /// so a `None` there propagates unchanged). `u32::MAX` sits far above the macOS pid ceiling
    /// (~99999), so `ps` never knows it — the dead / unknown-pid path; `pid 1` (launchd) is always
    /// alive yet has no controlling terminal, so its `tpgid` resolves to none — the
    /// has-a-pid-but-no-foreground-group path. Both must map to `None`, not `Some(_)`.
    #[test]
    fn is_busy_is_none_without_a_determinable_foreground_group() {
        assert_eq!(is_busy(u32::MAX), None);
        assert_eq!(is_busy(1), None);
    }

    // ---- trmx-263 (T1): batched resolution — pure parsers over `ps -p a,b,c` output, and the
    // countable runner seam. RED first: written before the functions existed. The row shapes are
    // the ones MEASURED on macOS `ps` (Step-1 evidence): rows sorted by pid regardless of list order,
    // a dead pid silently omitted, tpgid `0`/`-1` for a process without a foreground group, `comm`
    // as the launched path (which may contain spaces).

    #[test]
    fn parse_leader_rows_keys_by_pid_whatever_the_order() {
        let map = parse_leader_rows("  300     1\n  100   100\n  200    77\n");
        let mut keys: Vec<u32> = map.keys().copied().collect();
        keys.sort_unstable();
        assert_eq!(keys, vec![100, 200, 300]);
        assert_eq!(map[&100], Some(100));
        assert_eq!(map[&200], Some(77));
        assert_eq!(map[&300], Some(1));
    }

    #[test]
    fn parse_leader_rows_omits_pids_without_a_row() {
        // 200 was in the list; `ps` printed nothing for it (gone), exit 0 — measured.
        let map = parse_leader_rows("  100   100\n  300   300\n");
        assert!(!map.contains_key(&200));
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn parse_leader_rows_maps_tpgid_0_and_minus_1_to_none() {
        let map = parse_leader_rows("   55     0\n   66    -1\n");
        assert_eq!(map[&55], None);
        assert_eq!(map[&66], None);
    }

    #[test]
    fn parse_leader_rows_skips_junk_and_blank_lines() {
        let map = parse_leader_rows("  PID TPGID\n\n  123   456\n  abc   def\n");
        assert_eq!(map.len(), 1);
        assert_eq!(map[&123], Some(456));
    }

    #[test]
    fn parse_name_rows_takes_the_basename_and_keeps_spaces_inside_comm() {
        let map = parse_name_rows(
            "   77 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper\n   78 sleep\n",
        );
        assert_eq!(map[&77], "Code Helper");
        assert_eq!(map[&78], "sleep");
    }

    #[test]
    fn parse_name_rows_skips_a_row_with_an_empty_name() {
        let map = parse_name_rows("   88 \n   89 /bin/zsh\n");
        assert!(!map.contains_key(&88));
        assert_eq!(map[&89], "zsh");
    }

    #[test]
    fn ps_rows_via_runs_ps_exactly_once_for_a_non_empty_list_with_sorted_deduplicated_pids() {
        let calls: std::cell::RefCell<Vec<Vec<String>>> = std::cell::RefCell::new(Vec::new());
        let out = ps_rows_via(
            |argv: &[String]| {
                calls.borrow_mut().push(argv.to_vec());
                Some("  100   100\n".to_string())
            },
            "pid=,tpgid=",
            &[300, 100, 200, 100],
        );
        assert_eq!(out.as_deref(), Some("  100   100\n"));
        let expected = vec!["-o", "pid=,tpgid=", "-p", "100,200,300"]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();
        assert_eq!(
            *calls.borrow(),
            vec![expected],
            "one execution, sorted + de-duplicated list"
        );
    }

    #[test]
    fn ps_rows_via_does_not_run_ps_for_an_empty_list() {
        let ran = std::cell::Cell::new(false);
        let out = ps_rows_via(
            |_argv: &[String]| {
                ran.set(true);
                Some(String::new())
            },
            "pid=,tpgid=",
            &[],
        );
        assert_eq!(out.as_deref(), Some(""));
        assert!(!ran.get(), "an empty list must not spawn");
    }

    #[test]
    fn ps_rows_via_returns_none_when_ps_cannot_be_spawned() {
        assert_eq!(
            ps_rows_via(|_argv: &[String]| None, "pid=,tpgid=", &[1]),
            None
        );
    }

    /// The all-dead contract, on the REAL `ps`: macOS exits 1 and prints nothing when every listed
    /// pid is gone (measured) — that is `Some(empty)`, not `None`, because `ps` ran.
    #[cfg(target_os = "macos")]
    #[test]
    fn foreground_leaders_of_all_dead_pids_is_some_empty() {
        let dead: Vec<u32> = (90001..99_000)
            .filter(|p| ps_column("pid=", *p).is_none())
            .take(2)
            .collect();
        assert_eq!(
            dead.len(),
            2,
            "could not find two unused pids in the valid range"
        );
        let map =
            foreground_leaders(&dead).expect("ps ran (exit 1, no rows) — not a spawn failure");
        assert!(map.is_empty());
    }

    /// The batched functions agree with the per-pid ones on the same live processes: this test's
    /// own pid (a tty or not, depending on how cargo was launched — both paths must agree) and
    /// launchd.
    #[cfg(target_os = "macos")]
    #[test]
    fn foreground_leaders_and_process_names_agree_with_the_per_pid_functions_on_live_pids() {
        let me = std::process::id();
        let leaders = foreground_leaders(&[me, 1]).expect("ps ran");
        assert!(leaders.contains_key(&me));
        assert!(leaders.contains_key(&1));
        assert_eq!(leaders[&me], foreground_leader_pid(me));
        let names = process_names(&[1]).expect("ps ran");
        assert_eq!(names[&1], "launchd");
    }

    // ---- trmx-159 (T1): pure parsers for the macOS foreground-metadata helpers ----

    /// Build a synthetic `KERN_PROCARGS2` buffer: a leading native-endian `c_int` argc, the
    /// executable path (NUL-terminated), two padding NULs (the kernel aligns argv after the exec
    /// path), then each `argv` entry NUL-terminated — except the last is left UNterminated when
    /// `terminate_last` is false, modeling a truncated buffer. Lets `parse_kern_procargs2` be
    /// exercised on canned bytes with no live process (the `parse_tpgid`/`parse_comm` pattern).
    #[cfg(target_os = "macos")]
    fn synth_procargs2(argc: i32, exec: &str, argv: &[&str], terminate_last: bool) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&argc.to_ne_bytes());
        buf.extend_from_slice(exec.as_bytes());
        buf.push(0); // terminates the exec path
        buf.push(0); // padding NULs between the exec path and argv[0]
        buf.push(0);
        for (i, s) in argv.iter().enumerate() {
            buf.extend_from_slice(s.as_bytes());
            if terminate_last || i + 1 < argv.len() {
                buf.push(0);
            }
        }
        buf
    }

    /// The tail is argv[1..]: argv[0] (and the separate leading exec path, plus its padding) are
    /// dropped, the remaining entries kept in order.
    #[cfg(target_os = "macos")]
    #[test]
    fn parse_kern_procargs2_returns_argv_tail_without_argv0() {
        let buf = synth_procargs2(3, "/bin/sleep", &["sleep", "30", "--verbose"], true);
        assert_eq!(
            parse_kern_procargs2(&buf),
            Some(vec!["30".to_string(), "--verbose".to_string()])
        );
    }

    /// A one-argument job (`sleep 30`) yields exactly its single tail entry.
    #[cfg(target_os = "macos")]
    #[test]
    fn parse_kern_procargs2_handles_a_single_tail_entry() {
        let buf = synth_procargs2(2, "/bin/sleep", &["sleep", "30"], true);
        assert_eq!(parse_kern_procargs2(&buf), Some(vec!["30".to_string()]));
    }

    /// A very long argv is capped at 16 tail entries (argv[1..=16]) — a bounded, predictable size.
    #[cfg(target_os = "macos")]
    #[test]
    fn parse_kern_procargs2_caps_the_tail_at_16() {
        let argv: Vec<String> = (0..40).map(|i| format!("a{i}")).collect();
        let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let buf = synth_procargs2(refs.len() as i32, "/bin/x", &refs, true);
        let tail = parse_kern_procargs2(&buf).expect("a well-formed buffer parses");
        assert_eq!(tail.len(), 16, "the tail is capped at 16 entries");
        assert_eq!(tail.first().map(String::as_str), Some("a1"));
        assert_eq!(tail.last().map(String::as_str), Some("a16"));
    }

    /// argc <= 0, a truncated argv (fewer strings than argc, or a missing final NUL), and a buffer
    /// too short to even hold argc all resolve to `None` — never a partial or bogus tail.
    #[cfg(target_os = "macos")]
    #[test]
    fn parse_kern_procargs2_rejects_nonpositive_truncated_and_empty() {
        // argc <= 0 short-circuits before any argv parsing.
        assert_eq!(
            parse_kern_procargs2(&synth_procargs2(0, "/bin/x", &[], true)),
            None
        );
        assert_eq!(
            parse_kern_procargs2(&synth_procargs2(-1, "/bin/x", &["x"], true)),
            None
        );
        // argc claims three argv strings but only two are present.
        assert_eq!(
            parse_kern_procargs2(&synth_procargs2(3, "/bin/x", &["x", "y"], true)),
            None
        );
        // The final argv string is missing its terminating NUL.
        assert_eq!(
            parse_kern_procargs2(&synth_procargs2(2, "/bin/x", &["x", "y"], false)),
            None
        );
        // Empty, and shorter than a `c_int` argc.
        assert_eq!(parse_kern_procargs2(&[]), None);
        assert_eq!(parse_kern_procargs2(&[1, 0]), None);
    }

    /// `path_names_a_tty` accepts pty slaves and serial/console ttys and rejects other
    /// character-special devices such as `/dev/null` — the discriminator `foreground_stdin_is_tty`
    /// relies on (both a pty and `/dev/null` are character devices, so only the vnode path
    /// separates them).
    #[cfg(target_os = "macos")]
    #[test]
    fn path_names_a_tty_accepts_ptys_and_rejects_dev_null() {
        assert!(path_names_a_tty("/dev/ttys003"));
        assert!(path_names_a_tty("/dev/tty"));
        assert!(path_names_a_tty("/dev/ttyp0"));
        assert!(path_names_a_tty("/dev/console"));
        assert!(!path_names_a_tty("/dev/null"));
        assert!(!path_names_a_tty("/dev/zero"));
        assert!(!path_names_a_tty(""));
        assert!(!path_names_a_tty("/private/tmp/foo"));
    }

    /// trmx-159 (Step-8 review fix): a fd 0 that is a PIPE is determinably NOT a tty ⇒ `Some(false)`,
    /// distinct from an uninspectable pid ⇒ `None`. A `sleep` spawned with a piped stdin exercises the
    /// non-vnode branch directly (no PTY needed); `u32::MAX` is a pid the kernel never knows. Without
    /// this, a piped foreground program would resolve `None` and — via the classifier's partial-metadata
    /// fail-safe — wrongly read `interactive` instead of `plain`.
    #[cfg(target_os = "macos")]
    #[test]
    fn foreground_stdin_is_tty_is_false_for_a_pipe_and_none_for_a_dead_pid() {
        use std::process::{Command, Stdio};
        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep with a piped stdin");
        let pid = child.id();
        let observed = foreground_stdin_is_tty(pid);
        // Reap before asserting so a failed assertion never leaks the child.
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(
            observed,
            Some(false),
            "a piped stdin is determinably not a tty"
        );
        assert_eq!(
            foreground_stdin_is_tty(u32::MAX),
            None,
            "an unknown pid stays None"
        );
    }

    // ---- trmx-197: the interpreter-shim unwrap (pure table) ----

    /// String-slice sugar for the argv-tail fixtures below.
    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn is_interpreter_matches_node_bun_deno_and_the_python_family() {
        for name in [
            "node",
            "bun",
            "deno",
            "Node",
            "/usr/local/bin/node",
            "python",
            "python3",
            "python3.12",
            "/usr/bin/Python3",
        ] {
            assert!(is_interpreter(name), "{name} IS an interpreter");
        }
    }

    #[test]
    fn is_interpreter_rejects_non_interpreters_and_malformed_python_versions() {
        for name in [
            "",
            "zsh",
            "sleep",
            "ruby",
            "nodejs",
            "python-config",
            "pythonw",
            "python.",
            "python3.",
            "python3..12",
        ] {
            assert!(!is_interpreter(name), "{name} is NOT an interpreter");
        }
    }

    /// The unwrap recovers the CLI identity from the shebang-launcher shape — the operator's exact
    /// codex case first (comm `node`, argv tail = the PATH-resolved launcher path, no user args).
    #[test]
    fn unwrap_interpreter_shim_unwraps_the_shebang_launcher_shape() {
        assert_eq!(
            unwrap_interpreter_shim(
                "node",
                &argv(&["/Users/x/.nvm/versions/node/v24.12.0/bin/codex"])
            ),
            Some(("codex".to_string(), vec![]))
        );
        // A relative script path; the CLI's own flags become the effective tail.
        assert_eq!(
            unwrap_interpreter_shim("node", &argv(&["./fakecodex", "--flag"])),
            Some(("fakecodex".to_string(), vec!["--flag".to_string()]))
        );
        // A pip entry point under a versioned python.
        assert_eq!(
            unwrap_interpreter_shim("python3.12", &argv(&["/opt/bin/aider", "--model", "x"])),
            Some((
                "aider".to_string(),
                vec!["--model".to_string(), "x".to_string()]
            ))
        );
        // A known script extension is stripped (pnpm-style shims exec the .js directly)…
        assert_eq!(
            unwrap_interpreter_shim("node", &argv(&["/x/codex.js"])),
            Some(("codex".to_string(), vec![]))
        );
        // …but never down to an empty stem; and the script's case is preserved (the TS consumers
        // lowercase for comparison themselves).
        assert_eq!(
            unwrap_interpreter_shim("node", &argv(&["/x/.js"])),
            Some((".js".to_string(), vec![]))
        );
        assert_eq!(
            unwrap_interpreter_shim(
                "/usr/local/bin/Python3",
                &argv(&["/opt/homebrew/bin/Aider"])
            ),
            Some(("Aider".to_string(), vec![]))
        );
    }

    /// Every non-shim shape is identity (`None`): bare REPLs, flag-first invocations, unlisted
    /// leaders, and a script token with an empty basename. These pin that the unwrap can never
    /// change today's behavior outside the shebang-launcher shape.
    #[test]
    fn unwrap_interpreter_shim_is_identity_for_bare_repls_flags_and_non_interpreters() {
        assert_eq!(unwrap_interpreter_shim("node", &[]), None);
        assert_eq!(unwrap_interpreter_shim("node", &argv(&["-e", "x"])), None);
        assert_eq!(
            unwrap_interpreter_shim("python3", &argv(&["-m", "aider"])),
            None
        );
        assert_eq!(
            unwrap_interpreter_shim("node", &argv(&["--max-old-space-size=4096", "/x/cli.js"])),
            None
        );
        assert_eq!(unwrap_interpreter_shim("sleep", &argv(&["30"])), None);
        assert_eq!(unwrap_interpreter_shim("zsh", &argv(&["script.sh"])), None);
        assert_eq!(
            unwrap_interpreter_shim("python-config", &argv(&["x"])),
            None
        );
        assert_eq!(unwrap_interpreter_shim("node", &argv(&["/weird/"])), None);
    }
}
