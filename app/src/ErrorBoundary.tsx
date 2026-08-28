// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-237 (grill H3): the last-resort recovery surface. React 19 unmounts the entire root when a render
// error escapes, so before this the app became a BLANK WINDOW while every PTY child stayed alive in Rust —
// unreachable, and (because the shell has no other UI) unkillable from the app itself. The boundary keeps
// something on screen, says the one thing the user needs to hear (the shells survived), and offers the two
// honest recoveries.
//
// Per-surface actions are load-bearing, not cosmetic: `quit_confirmed` refuses any non-PTY-owner window
// (main.rs), so a Quit button on the SETTINGS surface would do nothing while the main window's children
// stayed alive. Settings therefore closes itself; only the main surface can quit the app.
//
// Every action is injected — the boundary performs no IPC and imports no Tauri API, so it renders in a
// plain browser and under jsdom exactly as it does in the packaged app.
import React from "react";

export type ErrorSurface = "main" | "settings";

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Which window this boundary guards — decides whether Quit or Close window is offered. */
  surface: ErrorSurface;
  /** Reload the webview (the cheap recovery: the Rust side and its sessions are untouched). */
  onReload: () => void;
  /** MAIN surface only: quit the app for real (teardown + reap). */
  onQuit?: () => void;
  /** SETTINGS surface only: close this window, leaving the terminal alone. */
  onCloseWindow?: () => void;
  /** Diagnostic sink; defaults to the app log (console + backend log file, trmx-236). */
  onError?: (error: unknown, componentStack?: string) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Best-effort: a throwing sink must not take down the fallback that is about to render.
    try {
      this.props.onError?.(error, info.componentStack ?? undefined);
    } catch {
      /* the surface matters more than the report */
    }
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { surface, onReload, onQuit, onCloseWindow } = this.props;
    return (
      <div className="error-boundary" role="alert">
        <h1 className="error-boundary__title">Termixion hit an internal error</h1>
        <p className="error-boundary__body">
          Your shells are still running. Reloading keeps them — they are owned by the app, not by this
          window.
        </p>
        <pre className="error-boundary__detail">{error.message}</pre>
        <div className="error-boundary__actions">
          <button type="button" onClick={onReload}>
            Reload
          </button>
          {surface === "main" ? (
            <button type="button" onClick={onQuit}>
              Quit Termixion
            </button>
          ) : (
            <button type="button" onClick={onCloseWindow}>
              Close window
            </button>
          )}
        </div>
      </div>
    );
  }
}
