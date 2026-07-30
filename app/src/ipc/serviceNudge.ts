// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-224: observe the backend's payload-less `services:open-paths` wake-up. Same
// teardown-before-resolve pattern as App's realObserveTabsAction, plus one deliberate
// extra: when the registration RESOLVES (and only while still live), it fires one nudge
// itself — the registration-completion drain. A nudge emitted before this listener
// registered is lost by the event bus, but its paths persist in the backend queue, and
// this drain picks them up; a torn-down registration (StrictMode replay) is unlistened
// and never fires into a dead handler.

import { SERVICE_OPEN_PATHS_EVENT } from "./backend";
import { realEventBus, type EventBus } from "./eventBus";

/** Observe service open-paths wake-ups (nudges); returns a teardown. */
export type ServiceNudgeObservation = (onNudge: () => void) => () => void;

/** Factory over the event bus so the registration/teardown contract is unit-testable. */
export function makeObserveServiceNudge(bus: EventBus): ServiceNudgeObservation {
  return (onNudge) => {
    let live = true;
    let unlisten: (() => void) | undefined;
    bus
      .listen(SERVICE_OPEN_PATHS_EVENT, () => {
        if (live) onNudge();
      })
      .then((u) => {
        if (live) {
          unlisten = u;
          onNudge();
        } else {
          u();
        }
      })
      .catch(() => {
        // No Tauri runtime — no services, no nudges.
      });
    return () => {
      live = false;
      unlisten?.();
    };
  };
}

export const realObserveServiceNudge: ServiceNudgeObservation =
  makeObserveServiceNudge(realEventBus);
