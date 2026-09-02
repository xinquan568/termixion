// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-252: the same-origin worker for the `worker-src 'self'` active check. It answers so the check
// proves EXECUTION, not merely construction — a worker that is created but silently inert must fail.
self.onmessage = function (event) {
  self.postMessage(event.data);
};
