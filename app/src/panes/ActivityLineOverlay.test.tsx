// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-91 + trmx-160 (test-first): the activity-line overlay. It renders ONLY when App's resolved
// `visible` gate is true, is click-through (pointer-events: none), and stacks BELOW the badge. trmx-160
// makes the BUSY look the iTerm2 progress-bar clone (an isDark-keyed opaque track + two phase-offset
// green sweep layers), while the trmx-99 error FLASH keeps its original solid-tint look. jsdom runs
// with `css: false`, so runtime structure/inline props are asserted off the DOM while the animation /
// geometry facts are asserted off the real index.css rules (read via node:fs — the z-order idiom).
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

describe("ActivityLineOverlay (trmx-91 + trmx-160)", () => {
  it("renders the line when visible", () => {
    render(<ActivityLineOverlay visible color="rgba(220,38,38,0.8)" isDark flashing={false} />);
    expect(screen.getByTestId("pane-activity")).toBeInTheDocument();
  });

  it("renders NOTHING when not visible (App gates on lightActive ∧ the setting)", () => {
    const { container } = render(
      <ActivityLineOverlay visible={false} color="#4ade80" isDark flashing={false} />,
    );
    expect(screen.queryByTestId("pane-activity")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("is click-through: pointer-events is none in both variants", () => {
    const progress = render(
      <ActivityLineOverlay visible color="#f00" isDark flashing={false} />,
    );
    expect(screen.getByTestId("pane-activity").style.pointerEvents).toBe("none");
    progress.unmount();
    render(<ActivityLineOverlay visible color="#f00" isDark flashing />);
    expect(screen.getByTestId("pane-activity").style.pointerEvents).toBe("none");
  });

  it("busy (not flashing) renders the progress bar: the --progress track + exactly two phase-offset sweep layers", () => {
    const { container } = render(
      <ActivityLineOverlay visible color="#f00" isDark flashing={false} />,
    );
    const bar = screen.getByTestId("pane-activity");
    expect(bar.className).toContain("tx-activity-line--progress");
    // The busy bar is NOT inline-colored — the track + green sweep are theme-independent CSS.
    expect(bar.style.backgroundColor).toBe("");
    const sweeps = container.querySelectorAll(".tx-activity-line__sweep");
    expect(sweeps).toHaveLength(2);
    // The second layer carries the half-period offset so a bright blob is always visible.
    expect(sweeps[0].className).not.toContain("tx-activity-line__sweep--offset");
    expect(sweeps[1].className).toContain("tx-activity-line__sweep--offset");
  });

  it("keys the progress track/period on the theme mode: --dark vs --light", () => {
    const dark = render(<ActivityLineOverlay visible color="#f00" isDark flashing={false} />);
    expect(screen.getByTestId("pane-activity").className).toContain("tx-activity-line--dark");
    expect(screen.getByTestId("pane-activity").className).not.toContain("tx-activity-line--light");
    dark.unmount();
    render(<ActivityLineOverlay visible color="#f00" isDark={false} flashing={false} />);
    expect(screen.getByTestId("pane-activity").className).toContain("tx-activity-line--light");
  });

  it("flashing keeps the trmx-99 look: the --flash variant painted in the threaded error color, NOT the progress bar", () => {
    const { container } = render(
      <ActivityLineOverlay visible color="rgba(220, 38, 38, 0.8)" isDark flashing />,
    );
    const bar = screen.getByTestId("pane-activity");
    expect(bar.className).toContain("tx-activity-line--flash");
    expect(bar.className).not.toContain("tx-activity-line--progress");
    expect(bar.style.backgroundColor).toBe("rgba(220, 38, 38, 0.8)");
    // No green progress structure bleeds into a flash.
    expect(container.querySelectorAll(".tx-activity-line__sweep")).toHaveLength(0);
  });

  it("stacks the activity line BELOW the badge watermark and above the xterm screen", () => {
    const activityZ = ruleZIndex(indexCss, "tx-activity-line");
    const badgeZ = ruleZIndex(indexCss, "tx-badge");
    expect(activityZ).toBeLessThan(badgeZ);
    // …and above the xterm screen, which carries no z-index (z-auto) — the line's is a positive stack.
    expect(activityZ).toBeGreaterThan(0);
  });
});

// trmx-160: the CSS facts jsdom can't run (css:false) — pinned by regex over the real index.css so a
// change to the geometry / gradient / period / phase-offset / reduced-motion is caught.
describe("activity-line progress-bar CSS (trmx-160)", () => {
  it("keeps the 2px bar height", () => {
    expect(/\.tx-activity-line\s*\{[^}]*height:\s*2px/.test(indexCss)).toBe(true);
  });

  it("uses an opaque black track in dark mode and white in light mode", () => {
    expect(/\.tx-activity-line--dark\b[^{]*\{[^}]*background:\s*#0{3,6}\b/.test(indexCss)).toBe(true);
    expect(/\.tx-activity-line--light\b[^{]*\{[^}]*background:\s*#f{3,6}\b/i.test(indexCss)).toBe(true);
  });

  it("sweeps with a 3s period in dark mode and 6s in light mode", () => {
    expect(
      /\.tx-activity-line--dark\b[^}]*\.tx-activity-line__sweep\b[^{]*\{[^}]*animation:[^;]*\b3s\b/.test(indexCss),
    ).toBe(true);
    expect(
      /\.tx-activity-line--light\b[^}]*\.tx-activity-line__sweep\b[^{]*\{[^}]*animation:[^;]*\b6s\b/.test(indexCss),
    ).toBe(true);
  });

  it("phase-offsets the second layer by half a period (negative time: -1.5s dark / -3s light)", () => {
    expect(/--dark\b[^}]*__sweep--offset\b[^{]*\{[^}]*animation-delay:\s*-1\.5s/.test(indexCss)).toBe(true);
    expect(/--light\b[^}]*__sweep--offset\b[^{]*\{[^}]*animation-delay:\s*-3s/.test(indexCss)).toBe(true);
  });

  it("sweeps the full travel translateX(-100%) → translateX(100%)", () => {
    expect(
      /@keyframes\s+tx-activity-sweep\s*\{[^}]*translateX\(-100%\)[\s\S]*?translateX\(100%\)/.test(indexCss),
    ).toBe(true);
  });

  it("peaks EACH mode's sweep gradient at pure green (#00ff00)", () => {
    // Match the dark and light sweep rule BODIES separately, so a light sweep that lost its #00ff00
    // peak can't be masked by the dark gradient's / reduced-motion rule's occurrences.
    const darkSweep = /\.tx-activity-line--dark\s+\.tx-activity-line__sweep\s*\{([^}]*)\}/.exec(indexCss);
    const lightSweep = /\.tx-activity-line--light\s+\.tx-activity-line__sweep\s*\{([^}]*)\}/.exec(indexCss);
    expect(darkSweep).not.toBeNull();
    expect(lightSweep).not.toBeNull();
    expect(/#00ff00/i.test(darkSweep![1])).toBe(true);
    expect(/#00ff00/i.test(lightSweep![1])).toBe(true);
  });

  it("respects prefers-reduced-motion: no sweep animation, a static peak-color bar", () => {
    const rm = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/.exec(indexCss);
    expect(rm).not.toBeNull();
    const block = rm![0];
    expect(/\.tx-activity-line__sweep\b[^{]*\{[^}]*animation:\s*none/.test(block)).toBe(true);
    expect(/#00ff00/i.test(block)).toBe(true);
  });
});
