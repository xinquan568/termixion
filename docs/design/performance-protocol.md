# The Termixion performance protocol (NFR-1, trmx-78)

How Termixion's performance claims are **measured**, on what, and against which budgets. The
instrument is the in-binary `--perf` harness; the record is a JSON report committed under
`docs/design/perf-results/`. CI compiles the harness but never runs it as a gate — CI runners are
noise; the **reference Mac is the measurement instrument**.

## 1. Reference machine + run conditions

- **Machine:** the M1 Pro reference Mac (the `machine` block in each committed report records the
  exact model/chip/macOS — filled by `scripts/perf.sh --commit`).
- **Conditions (validity requirements, not suggestions):** app window **frontmost and fully
  visible** (rAF throttles when occluded — an occluded run *fabricates* dropped frames), display
  awake, machine on AC power, no heavy background load. The report records `hasFocus` at mount as
  a validity marker.
- **Build:** budgets are judged on the **release** build only
  (`(cd crates/termixion-tauri && cargo tauri build)`). The harness ships in debug too (for
  iteration), but `perf.sh --commit` refuses a `"build": "debug"` report.

## 2. How to run

```
(cd crates/termixion-tauri && cargo tauri build)   # release bundle
scripts/perf.sh                                    # run + verdict (exit 0/1)
scripts/perf.sh --commit                           # + machine block + copy into perf-results/
```

`perf.sh` launches the packaged app with `--perf` and `TERMIXION_PERF_OUT=<dir>`; the app
self-drives and exits 0/1 on the budget verdict (`report.json` lands either way). A Rust-side
watchdog (`PERF_WATCHDOG_SECS = 300`) fails a hung run; it is ≈3× the scenario schedule below.

## 3. Metric definitions (honest edition)

**Typing latency ("key→glyph").** The measured loop is the FULL production round-trip:
`performance.now()` at `sendPtyInput` → Tauri `pty_write` → PTY → **shell echo** (tty-layer echo
under `cat > /dev/null`) → IPC channel frame → `term.write(chunk, cb)` (xterm parse completion) →
one `requestAnimationFrame` → sample. This **includes the PTY echo round-trip** — stricter than a
compositor-level key→glyph, which a webview cannot observe; what it cannot see is the OS
compositor's own present time (~one frame). Samples: `SCENARIO.typingKeys = 1000` keystrokes paced
`typingPaceMs = 50` (below human cadence, above frame rate), after 10 discarded warmup keys.
Reported: nearest-rank p50/p95/p99/max.

The echo discipline: the harness runs `stty -icanon && echo __TXPERF""READY__ && cat > /dev/null`
in the rc-free `zsh -f` — `-icanon` gives per-byte delivery with echo intact (no 1024-byte
canonical line limit under 1000 unterminated keystrokes) while keeping ISIG so ctrl-C ends the
scenario; `cat > /dev/null` means pure echo, no prompt redraw. Readiness and completion markers
are matched **contiguous-only**; the sent lines carry a `""` split so the command's own echo can
never satisfy a wait (the smoke's marker discipline).

**Scroll throughput (dropped frames).** While output streams, the harness samples
`requestAnimationFrame` timestamps; an inter-frame gap `> 1.5 × 16.7 ms` contributes
`round(gap/16.7) − 1` missed frames; `dropped % = missed / (rendered + missed)`. Three scenarios:
`seq 1 300000` (burst), `yes` for 5 s (sustained, ended by SIGINT), and scrollback paging (20
pages up + 20 down through the filled buffer via xterm `scrollPages`, 100 ms pace).

**Renderer assertion.** The report must say `renderer: "webgl"` — a silent DOM fallback
invalidates every number, so the harness fails such a run outright without driving scenarios.

## 4. Budgets (NFR-1)

| Metric | Budget |
| --- | --- |
| Typing latency | p50 ≤ **16 ms**, p95 ≤ **33 ms** |
| Dropped frames, every scroll scenario | < **5 %** |

Enforced by `evaluatePerf` (`app/src/perf/evaluatePerf.ts`, `BUDGETS`) → `perf_done` exit code.

## 5. Fidelity boundary

The perf mount reuses the production chokepoint (`realDeps.createTerminal` + `mountTerminal` —
identical xterm options, WebGL-first strategy) and the production transport (`openPty`,
`sendPtyInput`, the Tauri channel), but mounts **no React tree**: the tab strip and title-hint UI
churn are deliberately outside the measured loop (the backend's 1 Hz foreground-title poller still
runs — `open_pty` wakes it for any session). If tab-layer cost is ever suspected, the designated
check is a full-surface re-measure, not this harness. The v0.0.9 Beta-hardening re-run measures
under multi-pane load using this same protocol.

## 6. Report schema (frozen: `schema: 1`, additive-only)

```jsonc
{
  "schema": 1,
  "build": "release",             // budgets recorded from release only
  "renderer": "webgl",            // validity assertion
  "hasFocus": true,               // validity marker at mount
  "scenarios": {
    "typing":           { "count": 1000, "p50": 0, "p95": 0, "p99": 0, "max": 0 },
    "scrollSeq":        { "totalFrames": 0, "missed": 0, "droppedPct": 0 },
    "scrollYes":        { "totalFrames": 0, "missed": 0, "droppedPct": 0 },
    "scrollbackPaging": { "totalFrames": 0, "missed": 0, "droppedPct": 0 }
  },
  "budgets": { "typingP50Ms": 16, "typingP95Ms": 33, "droppedPct": 5 },
  "pass": true,
  "reason": "all budgets met (…)",
  "machine": { "model": "…", "chip": "…", "macos": "…", "memoryBytes": 0 },  // --commit adds
  "idle": { "oneTab": { "cpuPct": 0, "rssMb": 0 }, "threeTabs": { "cpuPct": 0, "rssMb": 0 } }  // §7 adds
}
```

Committed as `docs/design/perf-results/<date>-v<version>.json`. v0.0.9 re-runs diff against these.

## 7. Idle-cost spot-check (recorded, no budget)

With the release app idle (shell prompt, no output): sample 60 s of CPU % and memory with one tab,
then with three tabs — `top -l 60 -s 1 -pid <pid> -stats cpu,mem | tail -n +2` (or Activity
Monitor's 60 s sample), record the average CPU % and RSS into the results file's `idle` block by
hand. The 1 Hz foreground-title poller is part of what this number watches; the 1-vs-3-tab
comparison surfaces its scaling.

## 8. If budgets fail (the optimization ladder)

One change per commit (`perf(...)` type — surfaces as **Changed** in the changelog), before/after
numbers in the commit message, re-run `perf.sh` between steps, stop at green:

1. **Webview/options tier:** confirm WebGL active; hunt per-keystroke synchronous work; audit
   budget-relevant xterm options (documented here when chosen).
2. **Channel coalescing tier:** batch multiple PTY reads per channel send in the `main.rs` send
   closure (the core pump forwards each read today). Moving the policy INTO the core pump is
   allowed only with a golden test — it changes the pump's chunking contract.
3. **ADR tier:** if profiling shows Channel IPC itself is the bottleneck and budgets still fail,
   ADR-0001's documented fallback applies — move the output stream (only) to a local WebSocket,
   re-measure, record **ADR-0002**. Lands in `termixion-tauri` + `app`; not a casual commit.
