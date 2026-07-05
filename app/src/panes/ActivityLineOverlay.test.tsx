// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-91 (sub-task F, test-first): the activity-line overlay renders its 2px bar ONLY when App's
// resolved `visible` gate is true (the debounce ∧ the setting), paints in the theme color App threads,
// is click-through (pointer-events: none) so it never steals the terminal's clicks, and — the load-
// bearing z-order — stacks BELOW the trmx-90 badge watermark. jsdom runs with `css: false`, so the
// inline color/pointer-events are asserted off the element while the z-order contract is asserted off
// the real index.css rules (read via node:fs — a `?raw` import of a .css file arrives empty under
// css:false, the txCssVars.test.ts note; the CSS is the only place the stacking numbers live).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityLineOverlay } from "./ActivityLineOverlay";

const indexCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../index.css"),
  "utf8",
);

/** The z-index declared for `.<className>` in index.css (the runtime stacking source of truth). */
function ruleZIndex(css: string, className: string): number {
  const match = new RegExp(`\\.${className}\\s*\\{[^}]*?z-index:\\s*(\\d+)`).exec(css);
  if (!match) throw new Error(`no z-index found for .${className} in index.css`);
  return Number(match[1]);
}

describe("ActivityLineOverlay (trmx-91)", () => {
  it("renders the line when visible", () => {
    render(<ActivityLineOverlay visible color="rgba(22, 163, 74, 0.8)" />);
    expect(screen.getByTestId("pane-activity")).toBeInTheDocument();
  });

  it("paints in the theme color App threads (the success tint at ~80% alpha)", () => {
    render(<ActivityLineOverlay visible color="rgba(22, 163, 74, 0.8)" />);
    expect(screen.getByTestId("pane-activity").style.backgroundColor).toBe("rgba(22, 163, 74, 0.8)");
  });

  it("is click-through: pointer-events is none so a click at its position reaches the terminal beneath", () => {
    render(<ActivityLineOverlay visible color="#4ade80" />);
    expect(screen.getByTestId("pane-activity").style.pointerEvents).toBe("none");
  });

  it("renders NOTHING when not visible (App gates on the debounce ∧ the setting)", () => {
    const { container } = render(<ActivityLineOverlay visible={false} color="#4ade80" />);
    expect(screen.queryByTestId("pane-activity")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("stacks the activity line BELOW the trmx-90 badge watermark (z-order: badge wins)", () => {
    const activityZ = ruleZIndex(indexCss, "tx-activity-line");
    const badgeZ = ruleZIndex(indexCss, "tx-badge");
    expect(activityZ).toBeLessThan(badgeZ);
    // …and above the xterm screen, which carries no z-index (z-auto) — the line's is a positive stack.
    expect(activityZ).toBeGreaterThan(0);
  });
});
