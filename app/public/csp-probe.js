// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-252 (M3): the CSP violation collector, as a CLASSIC script so it executes during head parsing
// — before the deferred module bundle and before the `<link rel="stylesheet">` Vite emits into
// dist/index.html (which does NOT exist in the source HTML; verified against a real build).
//
// PASSIVE CAPTURE IS DIAGNOSTIC ONLY — NO TEST ASSERTS ON IT. Vite injects `/@vite/client` with
// `head-prepend`, so in dev this script is provably not first in the document and a violation raised
// by the client itself would be missed. That is accepted rather than argued with: every pass/fail
// condition in the probe (app/src/smoke/cspProbe.ts) comes from ACTIVE checks that run after this
// listener is unambiguously live, so no verdict depends on winning a race with the parser.
(function () {
  var collected = [];
  window.__cspViolations = collected;
  window.addEventListener("securitypolicyviolation", function (event) {
    collected.push({
      effectiveDirective: event.effectiveDirective || event.violatedDirective || "",
      blockedURI: event.blockedURI || "",
      sourceFile: event.sourceFile || "",
    });
  });
})();
