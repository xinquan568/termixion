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
    let tpgid_raw = ps_column("tpgid=", shell_pid)?;
    let tpgid = parse_tpgid(&tpgid_raw)?;
    let comm_raw = ps_column("comm=", tpgid)?;
    let name = parse_comm(&comm_raw)?;
    Some(ForegroundProcess { pid: tpgid, name })
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
/// no controlling terminal / no foreground group, or `ps` fails — i.e. exactly the cases
/// [`foreground_process`] yields `None`. A pure map over it (no extra `ps` work), keeping platform
/// APIs in this one crate (R1/R2); a caller treats `None` as "unknown — do not gate on it".
pub fn is_busy(shell_pid: u32) -> Option<bool> {
    foreground_process(shell_pid).map(|fg| fg.pid != shell_pid)
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
}
