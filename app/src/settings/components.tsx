// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: small presentational building blocks for the Settings surface (grouped rows, buttons, a
// toggle, a status pill, a progress bar). Plain React + scoped CSS classes (settings.css) — no UI
// framework — so the About page reads as a clean, consistent settings panel.
// trmx-51 adds the vmark-style Select (a styled native <select> with an inline chevron) and the
// danger button variant the Reset section uses.
// trmx-80 (FR-13) adds the commit-on-blur/Enter fields the Terminal page's scrollback/font rows
// use: NumberField (clamped into [min, max], junk reverts, optional ± stepper) and TextField.
// trmx-81 (FR-2.2) adds SegmentedControl — the N-way single-choice control the Appearance page's
// Tab bar Position row uses (radiogroup semantics, roving tabindex, arrow-key stepping).
import { useEffect, useRef, useState, type ReactNode } from "react";

/** A titled group of setting rows (title omitted when empty). */
export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="tx-settings-group">
      {title ? <h2 className="tx-settings-group__title">{title}</h2> : null}
      <div className="tx-settings-group__body">{children}</div>
    </section>
  );
}

/** A single row: a label (+ optional description) on the left, a control on the right. */
export function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="tx-setting-row">
      <div className="tx-setting-row__text">
        <div className="tx-setting-row__label">{label}</div>
        {description ? <div className="tx-setting-row__desc">{description}</div> : null}
      </div>
      {children ? <div className="tx-setting-row__control">{children}</div> : null}
    </div>
  );
}

export type ButtonVariant = "primary" | "tertiary" | "success" | "danger";

/** A button with a few visual variants. */
export function Button({
  variant = "tertiary",
  onClick,
  disabled,
  children,
}: {
  variant?: ButtonVariant;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`tx-btn tx-btn--${variant}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** An on/off switch (accessible via role="switch"). */
export function Toggle({
  checked,
  onChange,
  label = "Toggle",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`tx-toggle${checked ? " tx-toggle--on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="tx-toggle__knob" />
    </button>
  );
}

/** A styled native <select> (vmark's Select shape): the popup stays OS-rendered, the closed
 * control matches the settings look. trmx-53: the chevron is a masked ::after on the wrapper,
 * tinted var(--tx-text-3) so it recolors with the theme (a stroke color baked into a data-URI
 * background could not — see the txCssVars source guard). */
export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <span className="tx-select-wrap">
      <select
        className="tx-select"
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} label={opt.label}>
            {opt.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** trmx-80: a text input that COMMITS on blur/Enter (not per keystroke — settings writes persist
 * to the config file and broadcast to the live terminal, so a commit is a deliberate act). The
 * draft tracks typing; an external `value` change (reset, cross-window broadcast) resyncs it.
 * A no-op commit (the unchanged value) is skipped so redundant config writes never happen. */
export function TextField({
  value,
  onCommit,
  placeholder,
  label,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  label?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <input
      type="text"
      className="tx-text"
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/** trmx-80: a numeric input with TextField's commit-on-blur/Enter contract, mirroring the
 * registry's number semantics (settingsStore parse/clampNumberSetting): INTEGERS ONLY (review
 * R4 — the backend's config_write rejects fractional values, so committing one would diverge the
 * UI/session from the file); junk (empty/NaN/fractional) reverts the draft to the current value
 * without committing; an integer is CLAMPED into [min, max] before it is committed and shown.
 * `stepper` adds ± buttons (the Font Size control) that step by one and disable at the bounds. */
export function NumberField({
  value,
  min,
  max,
  onCommit,
  label,
  stepper,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  label?: string;
  stepper?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  const commit = () => {
    // Number("") === 0, so an empty/whitespace draft must be rejected before conversion
    // (the same guard as the registry's parse — settingsStore.ts). Number.isInteger also
    // rejects fractional drafts like "12.5" (review R4: integers only, per the backend).
    const n = draft.trim() === "" ? NaN : Number(draft);
    if (!Number.isInteger(n)) {
      setDraft(String(value)); // junk (including fractions) reverts to the committed value
      return;
    }
    const clamped = clamp(n);
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  const step = (delta: number) => onCommit(clamp(value + delta));

  return (
    <span className="tx-number-wrap">
      {stepper ? (
        <button
          type="button"
          className="tx-stepper-btn"
          aria-label={`Decrease ${label ?? "value"}`}
          disabled={value <= min}
          onClick={() => step(-1)}
        >
          −
        </button>
      ) : null}
      <input
        type="text"
        inputMode="numeric"
        className="tx-number"
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      {stepper ? (
        <button
          type="button"
          className="tx-stepper-btn"
          aria-label={`Increase ${label ?? "value"}`}
          disabled={value >= max}
          onClick={() => step(1)}
        >
          +
        </button>
      ) : null}
    </span>
  );
}

/** trmx-81 (FR-2.2): an N-way single-choice control (the macOS segmented look) with radiogroup
 * semantics — role="radiogroup" on the frame, role="radio" + aria-checked per segment. CONTROLLED:
 * the checked segment follows `value`; a click reports through onChange, and clicking the
 * already-selected segment is a NO-OP (a settings write is a deliberate act — no redundant config
 * writes/broadcasts, the TextField/NumberField contract). Keyboard follows the native radio-group
 * pattern: roving tabindex (only the selected segment is tabbable) and arrow keys step the
 * selection with wraparound, moving focus along.
 *
 * trmx-82 (FR-2.3) adds `disabled` — the Orientation row while the bar sits top/bottom: the group
 * stays PERCEIVABLE (aria-disabled on the frame and every segment, not the native `disabled`, so
 * AT still announces the current value) but is fully inert — onChange never fires (clicks and
 * arrow keys alike) and every segment leaves the tab order (tabindex -1). The enabled render is
 * byte-identical to the trmx-81 control (no aria-disabled attribute at all). */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label?: string;
  disabled?: boolean;
}) {
  const groupRef = useRef<HTMLDivElement>(null);

  const select = (next: T) => {
    if (disabled) return; // inert by contract — no report, no write, no broadcast
    if (next !== value) onChange(next);
  };

  // Arrow-key stepping: wrap around the option ring and carry focus to the new segment (the
  // roving tabindex would otherwise strand focus on a now-untabbable button). Disabled controls
  // never step (select would refuse anyway, but focus must not move either).
  const step = (delta: number) => {
    if (disabled || options.length === 0) return;
    const current = options.findIndex((opt) => opt.value === value);
    const next = ((current === -1 ? 0 : current) + delta + options.length) % options.length;
    select(options[next].value);
    const segments = groupRef.current?.querySelectorAll<HTMLButtonElement>("[role='radio']");
    segments?.[next]?.focus();
  };

  return (
    <div
      ref={groupRef}
      className="tx-segmented"
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled ? true : undefined}
    >
      {options.map((opt) => {
        const checked = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={disabled ? true : undefined}
            tabIndex={disabled ? -1 : checked ? 0 : -1}
            className={`tx-segmented__segment${checked ? " tx-segmented__segment--active" : ""}`}
            onClick={() => select(opt.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                step(1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                step(-1);
              }
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export type StatusTone = "neutral" | "success" | "info" | "error";

/** A small colored status label. */
export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`tx-status tx-status--${tone}`}>{children}</span>;
}

/** A determinate progress bar; `percent` is clamped 0–100 by the caller. */
export function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="tx-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className="tx-progress__fill" style={{ width: `${percent}%` }} />
    </div>
  );
}
