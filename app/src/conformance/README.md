# VT-conformance harness (trmx-64)

A curated, table-driven VT/xterm conformance suite that pins **Termixion's configured emulator** —
not bare xterm.js defaults, and not a fork. Every terminal in this directory is constructed by
`driver.ts#openTerm()` from **`emulationTerminalOptions()`** (`app/src/terminal/emulationOptions.ts`),
the same emulation-semantics slice production feeds into `new Terminal(...)` at the
`realDeps.createTerminal` chokepoint. We do not re-test xterm.js wholesale; we pin the sequences
Termixion's users depend on — each case cites its vttest menu item or esctest analog — so an xterm
upgrade or an option regression turns a behavior change into a red test. The founding example is the
trmx-64 fix itself: with the corrected `convertEol: false`, a bare LF indexes down and **keeps the
column** (`cursor-controls.test.ts`, "LF keeps the column (trmx-64 pin)").

Run it with:

```sh
pnpm --filter app exec vitest run src/conformance
```

## Groups

| File | Pins |
| --- | --- |
| `cursor-controls.test.ts` | CUP/HVP, CUU/CUD/CUF/CUB + clamping, CNL/CPL/CHA/VPA, BS/CR, **LF keeps column**, tabs (TAB/HTS/TBC/CHT/CBT), IND/RI/NEL, DECSC/DECRC |
| `erase-edit.test.ts` | ED 0/1/2, EL 0/1/2, ICH/DCH/ECH, IL/DL |
| `wrap-regions-origin.test.ts` | DECAWM on/off, wrap-pending last-column quirk, DECSTBM region scroll (both directions), DECOM |
| `sgr-colors.test.ts` | 16 colors → palette 0–15, 256-color, exact-RGB truecolor, attributes, SGR 0 reset |
| `alt-screen.test.ts` | DECSET/DECRST 47/1047/1049, cursor save/restore, scrollback integrity, no leak |
| `bracketed-paste.test.ts` | DECSET/DECRST 2004, paste envelope + LF→CR normalization |
| `mouse-reporting.test.ts` | tracking-mode acceptance (9/1000/1002/1003), 1006, SGR press/motion/release encoding, legacy X10 on the binary channel |
| `reports.test.ts` | DA1/DA2, DSR 5, CPR |
| `osc.test.ts` | OSC 0/2 titles (BEL **and** ST), unknown-OSC safety, OSC 8 hyperlinks |

## Tiers: headless vs packaged manual checklist

The suite runs against `@xterm/headless` — the emulator core with no DOM. Two production surfaces
required bridging, and one class of behavior cannot run headless at all:

- **Paste**: `paste()` is browser-only; the headless build ships none (verified against the
  installed 5.5.0 typings/runtime). The driver ports the browser clipboard transform verbatim
  (xterm.js `src/browser/Clipboard.ts`: LF→CR, then the `200~/201~` envelope) keyed off the
  emulator's **real** `modes.bracketedPasteMode` state, so DECSET 2004 parsing and mode bookkeeping
  are genuinely under test; the browser `paste()` call path itself is a manual-checklist item.
- **Mouse reports**: there is no public headless ingress for mouse input, but the report **encoder**
  (common-code `CoreMouseService`) is present and reachable via the internal `_core` seam
  (`driver.ts#mouseService`, existence-asserted so an upstream rename fails loudly). SGR
  press/motion/release encodings and the legacy X10 binary-channel routing are therefore covered
  headless. **Not** coverable headless — deferred to the packaged manual checklist as `it.skip`
  placeholders in `mouse-reporting.test.ts`: real DOM pointer events, pixel→cell coordinate
  translation, wheel reports (buttons 64/65), and modifier-key flags.
- **Hyperlink ranges**: OSC 8 parse-safety and text rendering are covered headless; link-range
  introspection and pointer activation are browser API (link providers), so hover/click behavior is
  a manual-checklist item.

## Deviations

Real upstream xterm.js bugs exposed by a case land here (the case becomes `it.skip` with a comment
linking its row) instead of failing the suite. Currently none.

| sequence | expected | actual | upstream ref |
| --- | --- | --- | --- |
| _none_ | | | |
