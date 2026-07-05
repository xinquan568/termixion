// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-90 (sub-task F, test-first): the badge overlay renders the pane's badge (colored + sized from
// the theme/cell metrics) when it exists and the pane is wide enough, renders nothing when there is no
// badge or the pane is too narrow, and is click-through (pointer-events: none) so it never steals the
// terminal's clicks — the scrollbar-overlay guard, applied to the badge watermark.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BadgeOverlay } from "./BadgeOverlay";

describe("BadgeOverlay (trmx-90)", () => {
  it("renders the badge text when set and the pane is wide enough", () => {
    render(<BadgeOverlay badge="prod" cellsWide={80} cellHeightPx={17} color="rgba(255,255,255,0.08)" />);
    const el = screen.getByTestId("pane-badge");
    expect(el).toHaveTextContent("prod");
  });

  it("paints in the theme's badge color and sizes the font at ~2× the cell height", () => {
    render(<BadgeOverlay badge="db" cellsWide={40} cellHeightPx={20} color="rgba(1, 2, 3, 0.5)" />);
    const el = screen.getByTestId("pane-badge");
    expect(el.style.color).toBe("rgba(1, 2, 3, 0.5)");
    expect(el.style.fontSize).toBe("40px"); // 2 × 20
  });

  it("is click-through: pointer-events is none so a click at its position reaches the terminal beneath", () => {
    render(<BadgeOverlay badge="prod" cellsWide={80} cellHeightPx={17} color="#fff" />);
    expect(screen.getByTestId("pane-badge").style.pointerEvents).toBe("none");
  });

  it("renders NOTHING when the pane has no badge", () => {
    const { container } = render(
      <BadgeOverlay badge={undefined} cellsWide={80} cellHeightPx={17} color="#fff" />,
    );
    expect(screen.queryByTestId("pane-badge")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders NOTHING for an empty-string badge (a cleared badge)", () => {
    render(<BadgeOverlay badge="" cellsWide={80} cellHeightPx={17} color="#fff" />);
    expect(screen.queryByTestId("pane-badge")).not.toBeInTheDocument();
  });

  it("renders NOTHING when the pane is too narrow (below the cell floor), even with a badge", () => {
    render(<BadgeOverlay badge="prod" cellsWide={3} cellHeightPx={17} color="#fff" />);
    expect(screen.queryByTestId("pane-badge")).not.toBeInTheDocument();
  });

  it("keeps a multi-line badge's newline (honors \\n from the OSC 1337 sanitizer)", () => {
    render(<BadgeOverlay badge={"line1\nline2"} cellsWide={80} cellHeightPx={17} color="#fff" />);
    // The raw text (with the LF) is present; CSS clamps it to 2 lines at render time.
    expect(screen.getByTestId("pane-badge").textContent).toBe("line1\nline2");
  });

  it("falls back to a default font size when the cell height is unknown (zero) but the badge shows", () => {
    render(<BadgeOverlay badge="prod" cellsWide={80} cellHeightPx={0} color="#fff" />);
    expect(screen.getByTestId("pane-badge").style.fontSize).toBe("28px");
  });
});
