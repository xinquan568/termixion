// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// Vitest global setup (D-2): register the jest-dom matchers (e.g. toBeInTheDocument) and unmount
// React trees between tests. Cleanup is explicit because `globals: false` disables Testing
// Library's automatic afterEach cleanup.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
});
