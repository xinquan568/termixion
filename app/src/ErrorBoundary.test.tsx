// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-237 (grill H3): the last-resort recovery surface. A React render error used to unmount the whole
// root (React 19) leaving a BLANK window with every PTY child alive in Rust and unreachable — the app
// looked dead while the shells were not. The boundary keeps a visible surface with the two honest actions
// (reload the webview; quit the app), and says the thing the user most needs to know: the shells survived.
//
// The surface distinction is load-bearing, not cosmetic: `quit_confirmed` refuses any non-PTY-owner window
// (main.rs), so a Quit button in the SETTINGS boundary would be a button that does nothing while the main
// window's children stay alive. The settings surface therefore offers "Close window" instead.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

/** A child that throws on render — the only way to drive a real boundary. */
function Boom({ message = "kaboom" }: { message?: string }): never {
  throw new Error(message);
}

/** React logs the caught error to console.error; silence it so the suite output stays readable. */
function withSilencedConsole(run: () => void): void {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    run();
  } finally {
    spy.mockRestore();
  }
}

describe("ErrorBoundary (trmx-237 H3)", () => {
  it("renders its children untouched when nothing throws", () => {
    render(
      <ErrorBoundary surface="main" onQuit={vi.fn()} onReload={vi.fn()}>
        <p>the terminal</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("the terminal")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reload/i })).toBeNull();
  });

  it("catches a render error and tells the user the shells are still running", () => {
    withSilencedConsole(() => {
      render(
        <ErrorBoundary surface="main" onQuit={vi.fn()} onReload={vi.fn()}>
          <Boom />
        </ErrorBoundary>,
      );
    });
    expect(screen.getByText(/internal error/i)).toBeTruthy();
    // The reassurance is the point of the surface: the user's work is not gone.
    expect(screen.getByText(/shells are still running/i)).toBeTruthy();
  });

  it("reports the caught error through the injected sink (so it reaches the log file)", () => {
    const onError = vi.fn();
    withSilencedConsole(() => {
      render(
        <ErrorBoundary surface="main" onQuit={vi.fn()} onReload={vi.fn()} onError={onError}>
          <Boom message="render blew up" />
        </ErrorBoundary>,
      );
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toContain("render blew up");
  });

  it("MAIN surface: offers Reload and Quit, and each invokes its injected action", () => {
    const onQuit = vi.fn();
    const onReload = vi.fn();
    withSilencedConsole(() => {
      render(
        <ErrorBoundary surface="main" onQuit={onQuit} onReload={onReload}>
          <Boom />
        </ErrorBoundary>,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(onReload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /quit/i }));
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  // The core of finding 4 from the plan review: quit_confirmed ignores non-PTY-owner callers, so a Quit
  // button here would be inert while the main window's children stayed alive. Offer the action that works.
  it("SETTINGS surface: offers Close window and NEVER Quit", () => {
    const onCloseWindow = vi.fn();
    withSilencedConsole(() => {
      render(
        <ErrorBoundary surface="settings" onCloseWindow={onCloseWindow} onReload={vi.fn()}>
          <Boom />
        </ErrorBoundary>,
      );
    });
    expect(screen.queryByRole("button", { name: /quit/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /close window/i }));
    expect(onCloseWindow).toHaveBeenCalledTimes(1);
  });
});
