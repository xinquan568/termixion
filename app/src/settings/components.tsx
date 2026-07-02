// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: small presentational building blocks for the Settings surface (grouped rows, buttons, a
// toggle, a status pill, a progress bar). Plain React + scoped CSS classes (settings.css) — no UI
// framework — so the About page reads as a clean, consistent settings panel.
// trmx-51 adds the vmark-style Select (a styled native <select> with an inline chevron) and the
// danger button variant the Reset section uses.
import type { ReactNode } from "react";

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
 * control matches the settings look; the chevron is an inline background SVG. */
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
