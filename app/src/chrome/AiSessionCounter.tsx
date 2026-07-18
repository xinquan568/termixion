// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-190: the AI-session counter — the first real occupant of the trmx-188 title-bar right
// slot. Presentational over the pure aiSessionBuckets model: App derives `sessions` from tab
// state (or the e2e fixture) and this component renders segments (`claude: 2/3 | … | All: 3/6`),
// the all-idle dim, the hover tooltip (per-session rows), and the click-to-cycle navigation.
// Display rules live in aggregate(); the wide/narrow visibility split is pure CSS over the
// classes emitted here (--all / --redundant), so the model and the stylesheet cannot disagree.
// The cycle position is a ref, not state — clicking must not re-render the bar — and it keys on
// sessionKey, so a re-derive of the sessions array never resets the cycle. No drag-region
// attribute anywhere: the slot is interactive content (the trmx-188 discipline).

import { useRef } from "react";
import {
  aggregate,
  nextAiSession,
  sessionKey,
  type AiSession,
} from "./aiSessionBuckets";

export interface AiSessionCounterProps {
  /** The AI sessions in tab order (from sessionsFrom, or the e2e fixture). */
  sessions: AiSession[];
  /** Focus a session's pane (App dispatches activateTab + focusPane). */
  onFocusSession: (session: { tabId: number; paneId: number }) => void;
}

export function AiSessionCounter({ sessions, onFocusSession }: AiSessionCounterProps) {
  const lastFocusedRef = useRef<string | null>(null);
  const model = aggregate(sessions);
  if (model.all === null) return null; // no AI sessions — the counter renders nothing

  const cycle = () => {
    const next = nextAiSession(sessions, lastFocusedRef.current);
    if (next === null) return;
    lastFocusedRef.current = sessionKey(next);
    onFocusSession(next);
  };

  return (
    <div
      className={`ai-counter${model.allIdle ? " ai-counter--idle" : ""}`}
      data-testid="ai-counter"
      role="button"
      tabIndex={0}
      aria-label="AI sessions — click to cycle focus"
      onClick={cycle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          cycle();
        }
      }}
    >
      {model.segments.map((segment) => (
        <span
          key={segment.bucket}
          className="ai-counter__segment"
          data-bucket={segment.bucket}
        >{`${segment.bucket}: ${segment.active}/${segment.total}`}</span>
      ))}
      <span
        className={`ai-counter__segment ai-counter__segment--all${
          model.all.redundant ? " ai-counter__segment--redundant" : ""
        }`}
        data-bucket="All"
      >{`All: ${model.all.active}/${model.all.total}`}</span>
      <div className="ai-counter__tooltip" data-testid="ai-counter-tooltip" role="tooltip">
        {sessions.map((session) => (
          <div
            key={sessionKey(session)}
            className="ai-counter__tooltip-row"
            data-active={session.active}
          >
            <span
              className={`ai-counter__dot${session.active ? " ai-counter__dot--active" : ""}`}
            />
            <span className="ai-counter__tooltip-bucket">{session.bucket}</span>
            <span className="ai-counter__tooltip-title">{session.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
