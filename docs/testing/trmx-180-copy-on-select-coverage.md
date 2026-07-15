# trmx-180 — Auto-copy-on-select: coverage audit & reliability verdicts

The [trmx-180](https://github.com/xinquan568/termixion/issues/180) review of FR-8
(auto-copy-on-select, trmx-95; native sink trmx-145). This document is the committed audit the
issue's acceptance criteria require: the scenario matrix mapping every behavior to a test tier (or
an explicit waiver), and the per-suspect verdict table for the field report "auto-copy after
selection still isn't working properly".

## Test tiers

| Tier | Harness | What it can reach | What it cannot |
| ---- | ------- | ----------------- | -------------- |
| unit | Vitest/jsdom, fake scheduler + fake clock (`copyOnSelect.test.ts`, `nativeClipboard.test.ts`, `unicodeCopy.test.ts`) | the pure gesture machine, DOM wiring with synthetic events, sink contract | real engine event order, real xterm selection, real timers |
| component | Vitest/jsdom (`TerminalView.test.tsx`) | per-pane attach/detach, the settings gate, live toggle | the gesture itself |
| e2e | Playwright/Chromium vs the Vite dev server (`e2e/copy-on-select.spec.ts`, D-3) | real xterm selection, REAL pointer events + capture, real timers, injected sink | the Tauri IPC + real pasteboard (no runtime in the dev server); WebKit specifics |
| packaged smoke | `cargo tauri build --debug` + `scripts/smoke.sh` (CI + operator) | real WKWebView + real pasteboard, end to end | fine-grained gesture permutations |

## Scenario matrix

| # | Scenario | Expected behavior | Tier | Test / waiver |
| - | -------- | ----------------- | ---- | ------------- |
| 1 | drag-select, release in host | copy once, deferred, final text | unit + e2e | `copies ONCE on pointerup`; e2e `real mouse drag-selection … exactly once` |
| 2 | mid-drag selection ticks | zero writes until release | unit | `never on mid-drag ticks` |
| 3 | click that collapses/changes nothing | zero writes, clipboard preserved | unit | `empty/collapsed never writes`; `gesture that did NOT change the selection` |
| 4 | double/triple-click word/line settle after release | copy the settled selection | unit + e2e | `reads the FINAL (settled) selection`; e2e `double-click word-selection` |
| 5 | re-drag the SAME text (fresh gesture) | writes again — deliberate intent | unit | `fresh gesture re-selecting the SAME text writes again` (trmx-180 fix D1.1) |
| 6 | trailing same-text tick right after a copy | deduped (anti-noise, trmx-95) | unit | `trailing same-text keyboard tick … stays deduped` |
| 7 | keyboard/programmatic re-selection past the dedup window | writes again | unit | `re-selecting the same text PAST the dedup window` (trmx-180 fix D1.2) |
| 8 | keyboard selection (Select-All), no pointer | one debounced write | unit | `debounces a no-pointer selection change` |
| 9 | pointerdown during a pending keyboard debounce | debounce superseded, no ghost write | unit | `pointerdown supersedes a pending keyboard debounce` |
| 10 | release order `pointerup` → `lostpointercapture` | copy once | unit (+ e2e implicitly: Chromium's real order) | `release order pointerup → captureLost` |
| 11 | release order `lostpointercapture` → `pointerup` (engine variance) | copy once | unit | `captureLost → same-turn pointerup still copies` (trmx-180 fix D2) |
| 12 | genuine cancel (`pointercancel`, window blur) | never copies, never sticks | unit | `pointercancel / blur mid-drag aborts`; `genuine cancel … never copies` |
| 13 | capture stolen mid-drag, no release | aborts (one tick), no copy, no stick | unit | `capture loss with NO release aborts` |
| 14 | selection cleared by reflow between release and deferred tick | copies the release-time text | unit | `selection cleared between pointerup and the deferred tick` (trmx-180 fix D3) |
| 15 | release outside the host, capture unavailable | doc-level fallback ends the gesture | unit | `falls back to document-level pointerup` |
| 16 | dispose with a copy pending | nothing written after teardown | unit | `dispose with a deferred copy pending`; `teardown removes all listeners` |
| 17 | auto-copy bytes == ⌘C bytes | identical extraction | unit + e2e | byte-equality anchor; e2e `byte-identical to getSelection()` |
| 18 | unicode fidelity (CJK/emoji/ZWJ) through the shared extraction | exact bytes | unit | `unicodeCopy.test.ts` (trmx-97) |
| 19 | setting off / live toggle | attach/detach follows `terminal.copyOnSelect` | component | `TerminalView.test.tsx` ×3 |
| 20 | sink write fails (IPC broken / no runtime) | swallowed, debug-logged, never fatal | unit | `nativeClipboard.test.ts` swallow + debug tests (trmx-180 fix D4) |
| 21 | sink → real pasteboard delivery (NSString, encoding) | correct bytes in other apps | packaged smoke | `scripts/smoke.sh` tier; trmx-145 acceptance pins the encoding path in unit |
| 22 | Option-drag selection over a mouse-owned app (htop) | selection + auto-copy still work | packaged smoke | **waiver (automated):** mouse-reporting needs a live PTY app; operator checklist item |
| 23 | split panes: select in pane A while pane B streams | A's text copied, no cross-pane interference | component (attach is per-pane) + packaged smoke | **waiver (e2e):** dev-server harness has no PTY to stream; per-pane attach pinned in `TerminalView.test.tsx` |
| 24 | WebKit-specific event delivery | tolerated by construction | — | **waiver:** CI has no WKWebView driver (D-3/R-3); D2 makes the machine order-tolerant on any engine; packaged smoke is the WKWebView tier |

Every FR-8 behavior row is either test-linked or carries an explicit waiver with its reason.
Waivers 22–24 are inherent harness bounds (no PTY / no WKWebView automation), not skipped work;
their behaviors live in the packaged-smoke tier.

## Per-suspect verdicts (the trmx-180 field report)

| Suspect (issue §"Suspect areas") | Verdict | Evidence |
| -------------------------------- | ------- | -------- |
| (a) `lastCopied` dedup latch never invalidated — re-selecting after the pasteboard changed elsewhere silently skips | **Confirmed mechanism, fixed** | Deterministic RED repro: `fresh gesture re-selecting the SAME text` + `PAST the dedup window` failed on the pre-fix machine (7-test RED run in the trmx-180 PR record); fixed by the bounded latch (gesture reset + `dedupWindowMs`) |
| (b) release event-order fragility (`lostpointercapture` vs `pointerup`) | **Confirmed susceptibility, hardened** | RED repro: `captureLost → same-turn pointerup` produced zero writes pre-fix; the soft-abort machine now copies under either order; spec-order + cancel semantics pinned |
| (c) one-tick deferral vs post-release selection mutation | **Confirmed mechanism, fixed** | RED repro: clearing the selection between release and the deferred tick dropped the copy pre-fix; the release-time capture fallback now writes; live-preference (word/line settle) pinned |
| (d) sink failures invisible | **Confirmed amplifier, made observable** | Any IPC failure previously produced silence indistinguishable from this bug report; now debug-logged (`[termixion] clipboard write failed:`), contract unchanged |
| Field attribution (which suspect hit the reporter) | **Open** | The issue has no repro details (gesture, app context, packaged vs dev). (a) is the most probable day-to-day trigger. If the symptom recurs post-fix: check the devtools console for the (d) debug line, then report gesture + app context on trmx-180 |

## Operator checklist (packaged-smoke tier)

After a packaged build (`cargo tauri build --debug` + `scripts/smoke.sh`):

1. Select in `less` output → paste in another app; repeat the SAME selection after copying
   something else elsewhere → paste is the re-selected text (suspect (a) end-to-end).
2. Option-drag over `htop` (mouse-owned) → selection auto-copies (matrix #22).
3. Split panes, stream `yes` in pane B, select in pane A → A's text pastes (matrix #23).
4. Multi-line + non-ASCII selection round-trip (— × 你好 🚀) preserves bytes (matrix #21, trmx-145).
5. Toggle Settings → Terminal → copy-on-select off → selection no longer copies; ⌘C still does.
