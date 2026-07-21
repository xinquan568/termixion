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
  awake, machine on AC power, no heavy background load. **Enforced:** the report records
  `hasFocus` at mount and `evaluatePerf` fails any run where it is not true (an occluded run can
  never pass, even if its numbers land inside the budgets); `perf.sh --commit` additionally
  refuses such reports.
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
invalidates every number, so the harness fails such a run outright without driving scenarios, and
the renderer is **re-read after the scenarios** (the mount handle flips to `"dom"` on a WebGL
context loss, so a mid-run fallback also fails the run).

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

**Applied at v0.0.4 (trmx-78 round 2), measured on the reference Mac (release):** the first valid
baseline passed typing (p50 3 ms / p95 10 ms) and paging (1.61 %) but failed the floods —
scrollSeq **94.29 %**, scrollYes **99.55 %** dropped (one IPC message per 4096-byte PTY read; a
`yes` field-run crossed as ~10.8 M tiny messages). Two ladder steps fixed it, one commit each:
(1) **micro-window batching** in the shell's sender (4 ms accumulate against the queueing,
non-backpressuring `channel.send`) → scrollSeq **0.00 %**, paging **2.48 %**, but scrollYes still
68.8 %; (2) **credit-based flow control** (`pty_ack` on xterm parse completion, 1 MiB unacked
window, bounded 500 ms park) → **all budgets met**: typing p50 2 ms / p95 7 ms, scrollSeq 0.00 %,
scrollYes 4.69 %, paging 0.00 % (`docs/design/perf-results/2026-07-04-v0.0.3.json`). The ADR tier
was not needed — Channel IPC clears the budgets once ingestion is bounded by the parse rate.

One change per commit (`perf(...)` type — surfaces as **Changed** in the changelog), before/after
numbers in the commit message, re-run `perf.sh` between steps, stop at green:

1. **Webview/options tier:** confirm WebGL active; hunt per-keystroke synchronous work; audit
   budget-relevant xterm options (documented here when chosen).
2. **Channel coalescing tier:** batch multiple PTY reads per channel send in the `main.rs` send
   closure (the core pump forwards each read today). Moving the policy INTO the core pump is
   allowed only with a golden test — it changes the pump's chunking contract.
3. **ADR tier:** if profiling shows Channel IPC itself is the bottleneck and budgets still fail,
   ADR-0001's documented fallback applies — move the output stream (only) to a local WebSocket,
   re-measure, record **a future ADR (ADR-0002 records the no-chezmoi decision, trmx-208)**. Lands in `termixion-tauri` + `app`; not a casual commit.

## 9. Multi-pane load (v0.0.9)

The single-pane run (§3) measures a quiet terminal. The v0.0.9 Beta-hardening re-run measures the
same NFR-1 scenarios **while five other terminals are alive** — the realistic "busy workspace" the
tab/pane model makes normal. It is a **load condition, not a new report**: the harness emits the
**same four scenario keys** and `evaluatePerf` + `BUDGETS` judge it **UNCHANGED** (§4).

- **Panes:** six xterms are mounted in **one** webview (`SCENARIO_MULTIPANE`, zero-based indices):
  - **`streamPaneIndices = [0, 1, 2, 3]`** — four **streaming** panes each running a `yes`/`seq`
    **mix** flood (even indices `seq 1 300000`, odd indices `yes`) as background LOAD. Their output
    is really rendered and flow-control-acked (real GPU/IPC cost — the busy neighborhood), but feeds
    **no sampler**: it is a discard sink, never a measured number.
  - **`typingPaneIndex = 4`** — typing latency is measured here, **busy-adjacent**: the exact
    readiness → warmup → 1000 paced keys → FIFO-matched round-trip of §3, but under the four-pane
    flood.
  - **`scrollPaneIndex = 5`** — the three scroll scenarios (`scrollSeq`, `scrollYes`,
    `scrollbackPaging`) run in a sixth pane, again under the flood.
- **Timing knobs** are the **single-pane values** (`SCENARIO`) — one source, quoted here and in the
  tests. The renderer assertion (§3) and the `hasFocus` validity gate (§1) apply identically; the
  renderer is read from the **measured (typing) pane** and re-read after the scenarios.
- **Budgets are the same** table (§4). The point is to show typing stays ≤ 16 ms p50 / 33 ms p95 and
  every scroll scenario < 5 % dropped **even under multi-pane load**, not to relax anything.

**How to run** (numbers are operator-run on the reference Mac, same conditions as §1):

```
(cd crates/termixion-tauri && cargo tauri build)      # release bundle
scripts/perf.sh --scenario multipane                  # run + verdict (exit 0/1)
scripts/perf.sh --scenario multipane --commit         # + machine block + copy into perf-results/
```

`perf.sh --scenario multipane` passes `TERMIXION_PERF_SCENARIO=multipane` to the app (the backend's
`perf_config` forwards a `scenario` field; `main.tsx` picks `runPerfMultipane`). A committed
multi-pane report lands as `docs/design/perf-results/<date>-v<version>-multipane.json` (the
`-multipane` suffix keeps it beside — not overwriting — the single-pane record for the same version).
