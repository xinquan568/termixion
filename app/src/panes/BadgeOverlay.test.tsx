// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-90 (sub-task F, test-first) + trmx-149: the badge overlay renders the pane's badge when it
// exists and the pane is wide enough, renders nothing when there is no badge or the pane is too
// narrow, and is click-through (pointer-events: none) so it never steals the terminal's clicks.
// trmx-149 replaces the old ~2×-cell-height sizing with iTerm2's fit-to-box model: the font size is
// the largest that fits width ≤ 0.5 × pane width AND height ≤ 0.2 × pane height (iTermBadgeLabel.m
// idealPointSize via badgeFit.ts — an injectable measure seam, so these tests pin exact sizes with
// a deterministic fake), plus a glyph-edge stroke in the theme BACKGROUND color (~2% of the font
// size, AppKit's NSStrokeWidthAttributeName @-2 idiom). jsdom runs css:false, so the inline
// fontSize / color / stroke / pointer-events are asserted off the element, while the STATIC look is
// pinned off the real index.css `.tx-badge` rule (read via node:fs — the ActivityLineOverlay idiom;
// a `?raw` CSS import arrives empty under css:false).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BadgeOverlay, type BadgeOverlayProps } from "./BadgeOverlay";
import { BADGE_FONT_FAMILY, type BadgeMeasure } from "./badgeFit";

// The deterministic fake measure (badgeFit.test.ts's model): width = widest line × fontPx × 0.6,
// height = lines × fontPx × 1.05. For "db" in a 400×200 pane the fit converges at 38px (hand-traced
// in badgeFit.test.ts); for "prod" in 10×10 it hits the iTerm2 floor of 4.
const fakeMeasure: BadgeMeasure = (text, fontPx) => {
  const lines = text.split("\n");
  const widest = Math.max(...lines.map((line) => line.length));
  return { width: widest * fontPx * 0.6, height: lines.length * fontPx * 1.05 };
};

function renderBadge(overrides: Partial<BadgeOverlayProps> = {}) {
  const props: BadgeOverlayProps = {
    badge: "prod",
    cellsWide: 80,
    paneWidthPx: 400,
    paneHeightPx: 200,
    color: "rgba(255, 255, 255, 0.08)",
    outlineColor: "rgb(17, 17, 17)",
    measure: fakeMeasure,
    ...overrides,
  };
  return render(<BadgeOverlay {...props} />);
}

describe("BadgeOverlay (trmx-90, trmx-149)", () => {
  it("renders the badge text when set and the pane is wide enough", () => {
    renderBadge({ badge: "prod" });
    expect(screen.getByTestId("pane-badge")).toHaveTextContent("prod");
  });

  it("sizes the font by the iTerm2 fit-to-box search over the pane geometry", () => {
    // "db" in 400×200 under the fake measure → 38 (height-bound: 38 × 1.05 = 39.9 < 0.2 × 200).
    renderBadge({ badge: "db" });
    expect(screen.getByTestId("pane-badge").style.fontSize).toBe("38px");
  });

  it("paints in the theme's badge color", () => {
    renderBadge({ badge: "db", color: "rgba(1, 2, 3, 0.5)" });
    expect(screen.getByTestId("pane-badge").style.color).toBe("rgba(1, 2, 3, 0.5)");
  });

  it("strokes the glyph edges in the theme BACKGROUND color at ~2% of the font size", () => {
    // fontSize 38 → stroke max(0.5, 0.02 × 38) = 0.76px, in the outline (background) color.
    renderBadge({ badge: "db", outlineColor: "rgb(17, 17, 17)" });
    expect(screen.getByTestId("pane-badge").style.webkitTextStroke).toBe(
      "0.76px rgb(17, 17, 17)",
    );
  });

  it("floors the stroke at 0.5px for tiny font sizes", () => {
    // 10×10 pane → the iTerm2 minimum of 4px → 0.02 × 4 = 0.08 → floored to 0.5px.
    renderBadge({ badge: "prod", paneWidthPx: 10, paneHeightPx: 10 });
    const el = screen.getByTestId("pane-badge");
    expect(el.style.fontSize).toBe("4px");
    expect(el.style.webkitTextStroke).toBe("0.5px rgb(17, 17, 17)");
  });

  it("falls back to 28px when the pane geometry is unknown (zero) but the badge shows", () => {
    renderBadge({ badge: "prod", paneWidthPx: 0, paneHeightPx: 0 });
    expect(screen.getByTestId("pane-badge").style.fontSize).toBe("28px");
  });

  it("falls back to 28px under jsdom's default measure (no canvas 2d context → null measurer)", () => {
    // No `measure` prop → the module-lazy makeCanvasBadgeMeasure(), which is null under jsdom.
    renderBadge({ badge: "prod", measure: undefined });
    expect(screen.getByTestId("pane-badge").style.fontSize).toBe("28px");
  });

  it("is click-through: pointer-events is none so a click at its position reaches the terminal beneath", () => {
    renderBadge({ badge: "prod" });
    expect(screen.getByTestId("pane-badge").style.pointerEvents).toBe("none");
  });

  it("renders NOTHING when the pane has no badge", () => {
    const { container } = renderBadge({ badge: undefined });
    expect(screen.queryByTestId("pane-badge")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders NOTHING for an empty-string badge (a cleared badge)", () => {
    renderBadge({ badge: "" });
    expect(screen.queryByTestId("pane-badge")).not.toBeInTheDocument();
  });

  it("renders NOTHING when the pane is too narrow (below the cell floor), even with a badge", () => {
    renderBadge({ badge: "prod", cellsWide: 3 });
    expect(screen.queryByTestId("pane-badge")).not.toBeInTheDocument();
  });

  it("keeps a multi-line badge's newline (honors \\n from the OSC 1337 sanitizer)", () => {
    renderBadge({ badge: "line1\nline2" });
    // The raw text (with the LF) is present; CSS clamps it to 2 lines at render time.
    expect(screen.getByTestId("pane-badge").textContent).toBe("line1\nline2");
  });
});

// trmx-149: the STATIC look lives in index.css (jsdom css:false makes the file the source of
// truth — the ActivityLineOverlay.test.tsx idiom). Pin iTerm2's margins (badgeTopMargin /
// badgeRightMargin, both 10 — iTermAdvancedSettingsModel.m) + the Helvetica-first stack that
// mirrors BADGE_FONT_FAMILY, and the pre-existing weight/clamp/stacking contract.
describe(".tx-badge CSS contract (trmx-149)", () => {
  const indexCss = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../index.css"),
    "utf8",
  );
  const match = /\.tx-badge\s*\{([^}]*)\}/.exec(indexCss);
  if (!match) throw new Error("no .tx-badge rule found in index.css");
  const rule = match[1];

  it("pins iTerm2's margins: top 10px / right 10px", () => {
    expect(rule).toMatch(/top:\s*10px/);
    expect(rule).toMatch(/right:\s*10px/);
  });

  it("uses the Helvetica-first font stack, mirroring BADGE_FONT_FAMILY (badgeFit.ts)", () => {
    const declared = /font-family:\s*([^;]+);/.exec(rule);
    expect(declared).not.toBeNull();
    // Normalize whitespace: the CSS may wrap the stack across lines; the token list must match
    // the canvas measurer's font string exactly (same fonts → same measurement).
    expect(declared![1].replace(/\s+/g, " ").trim()).toBe(BADGE_FONT_FAMILY);
  });

  it("keeps the watermark look: bold, tight line-height, capped width, 2-line clamp, pre-line", () => {
    expect(rule).toMatch(/font-weight:\s*700/);
    expect(rule).toMatch(/line-height:\s*1\.05/);
    expect(rule).toMatch(/max-width:\s*50%/);
    expect(rule).toMatch(/-webkit-line-clamp:\s*2/);
    expect(rule).toMatch(/white-space:\s*pre-line/);
  });

  it("keeps the stacking contract: above the xterm screen, below the scrollbar (z-index 4)", () => {
    expect(rule).toMatch(/z-index:\s*4\b/);
  });
});
