// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: the control-socket request seam. It reaches into control/ (L5) for `ControlRequest`,
// including through an inline `import("./controlRequestGuard")` TYPE — the dependency a name-only
// scan misses. L0 ipc/ may not import control, so it lives here.

import { realEventBus } from "../ipc/eventBus";
import { log } from "../ipc/logSink";
import { isControlRequest } from "./controlRequestGuard";

// trmx-101 (FR-9.4): observe the Rust control socket's requests over `control:request` — same
// teardown-before-resolve pattern. Each payload is `{ id, request }`; App routes it through the command
// dispatcher / builds the snapshot / sends text, then replies via `invoke("control_response")`.
export type { ControlRequest } from "./controlRequestGuard";
export type ControlRequestObservation = (
  onRequest: (req: import("./controlRequestGuard").ControlRequest) => void,
) => () => void;

export const realObserveControlRequest: ControlRequestObservation = (onRequest) => {
  let live = true;
  let unlisten: (() => void) | undefined;
  realEventBus
    .listen("control:request", (payload) => {
      // trmx-237 (H3): validate before destructuring. A malformed payload from a local `ctl` caller
      // used to throw inside this listener and escape into React; now it is dropped with a record.
      if (!live) return;
      if (!isControlRequest(payload)) {
        log.warn("control: malformed request payload dropped", payload);
        return;
      }
      onRequest(payload);
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — there is no control socket in a plain browser tab.
    });
  return () => {
    live = false;
    unlisten?.();
  };
};
