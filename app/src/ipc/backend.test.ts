// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-5 (test-first): the IPC bridge seams. The real `invoke`/`Channel` edge needs the Tauri runtime
// and is exercised in the real app; here we test the pure pieces with fakes. trmx-74 scopes every
// PTY command to a session: open_pty resolves { sessionId, title }, writes/resizes/closes carry the
// sessionId, and `pty:exited` arrives over the event bus — all pinned here with fake invoke/bus.
import { describe, it, expect, vi } from "vitest";
import {
  closePty,
  decodePtyFrame,
  encodePtyInput,
  getCoreVersion,
  onPtyExited,
  onSessionActivity,
  onTitleHint,
  openPty,
  PTY_EXITED_EVENT,
  sendPtyInput,
  sendPtyResize,
  SESSION_ACTIVITY_EVENT,
  setSessionTitle,
  TITLE_HINT_EVENT,
  wirePtyChannel,
  type InvokeFn,
  type MessageChannel,
  type SessionInfo,
} from "./backend";
import type { EventBus } from "./eventBus";

// `openPty` constructs a real Tauri `Channel`, whose constructor needs the runtime's
// `__TAURI_INTERNALS__` (absent in jsdom). Stub the module: `Channel` becomes a plain message sink
// (the exact `MessageChannel` slice `wirePtyChannel` drives) and `invoke` an inert fn — every test
// injects its own fake invoke anyway.
vi.mock("@tauri-apps/api/core", () => {
  class FakeChannel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return { Channel: FakeChannel, invoke: vi.fn() };
});

describe("getCoreVersion", () => {
  it("invokes the core_version command and returns its result", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue("1.2.3");
    await expect(getCoreVersion(invoke)).resolves.toBe("1.2.3");
    expect(invoke).toHaveBeenCalledWith("core_version");
  });

  it("propagates a rejected invoke", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockRejectedValue(new Error("no backend"));
    await expect(getCoreVersion(invoke)).rejects.toThrow("no backend");
  });
});

describe("decodePtyFrame", () => {
  it("turns a byte-number array into a Uint8Array", () => {
    expect(decodePtyFrame([104, 105])).toEqual(new Uint8Array([104, 105]));
    expect(new TextDecoder().decode(decodePtyFrame([104, 105]))).toBe("hi");
  });

  it("handles an empty frame", () => {
    expect(decodePtyFrame([])).toEqual(new Uint8Array([]));
  });
});

describe("wirePtyChannel", () => {
  it("routes decoded frames from the channel to the byte handler", () => {
    let onmessage: ((frame: number[]) => void) | undefined;
    const channel: MessageChannel<number[]> = {
      set onmessage(fn) {
        onmessage = fn;
      },
      get onmessage() {
        return onmessage as (frame: number[]) => void;
      },
    };
    const received: Uint8Array[] = [];

    wirePtyChannel(channel, (bytes) => received.push(bytes));

    // The backend's readiness frame ("channel-ready") must reach the handler as decoded bytes.
    const frame = Array.from(new TextEncoder().encode("channel-ready"));
    onmessage?.(frame);

    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0])).toBe("channel-ready");
  });
});

// trmx-74: open_pty resolves the session's identity — the id every later command is scoped to.
describe("openPty", () => {
  const session: SessionInfo = { sessionId: 7, title: "zsh" };

  it("resolves the backend's { sessionId, title } (id round-trip through invoke)", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue({ sessionId: 7, title: "zsh" });
    await expect(openPty(() => {}, 24, 80, undefined, invoke)).resolves.toEqual(
      session,
    );
  });

  it("invokes open_pty with exactly { channel, rows, cols } when no cwd is given", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(session);
    await openPty(() => {}, 30, 100, undefined, invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = invoke.mock.calls[0];
    expect(cmd).toBe("open_pty");
    expect(args).toEqual({ channel: expect.anything(), rows: 30, cols: 100 });
    // The cwd key must be ABSENT (not `cwd: undefined`) so Rust's Option<String> stays None.
    expect(Object.keys(args as object).sort()).toEqual(["channel", "cols", "rows"]);
  });

  it("passes cwd through when provided (Tauri camelCases Rust's snake_case params)", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(session);
    await openPty(() => {}, 24, 80, { cwd: "/Users/me/project" }, invoke);
    const [cmd, args] = invoke.mock.calls[0];
    expect(cmd).toBe("open_pty");
    expect(args).toEqual({
      channel: expect.anything(),
      rows: 24,
      cols: 80,
      cwd: "/Users/me/project",
    });
  });

  it("omits the cwd key when opts carry an explicitly-undefined cwd", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(session);
    await openPty(() => {}, 24, 80, { cwd: undefined }, invoke);
    const [, args] = invoke.mock.calls[0];
    expect(Object.keys(args as object).sort()).toEqual(["channel", "cols", "rows"]);
  });

  it("wires the channel's frames into onBytes (PTY output round-trip)", async () => {
    let channelArg: MessageChannel<number[]> | undefined;
    const invoke = vi.fn<InvokeFn>((_cmd, args) => {
      channelArg = (args as { channel: MessageChannel<number[]> }).channel;
      return Promise.resolve(session);
    });
    const received: Uint8Array[] = [];
    await openPty((bytes) => received.push(bytes), 24, 80, undefined, invoke);
    channelArg?.onmessage(Array.from(new TextEncoder().encode("hi")));
    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0])).toBe("hi");
  });

  // The response shape is asserted at the one place the contract lives: junk from a mismatched
  // backend must fail loudly here, not surface later as NaN session ids in pty_write calls.
  it.each([
    undefined,
    null,
    "0.0.2",
    7,
    {},
    { sessionId: 7 }, // missing title
    { title: "zsh" }, // missing sessionId
    { sessionId: "7", title: "zsh" }, // stringly-typed id
    { sessionId: NaN, title: "zsh" }, // non-finite id
    { sessionId: 7, title: 42 }, // non-string title
    { sessionId: 0, title: "zsh" }, // ids start at 1 (backend contract)
    { sessionId: -1, title: "zsh" }, // negative — no u64 maps here
    { sessionId: 1.5, title: "zsh" }, // fractional — could alias another session
    { sessionId: 2 ** 53, title: "zsh" }, // beyond Number.isSafeInteger — precision-lossy
  ])("rejects with a typed Error when open_pty resolves junk (%j)", async (junk) => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(junk);
    await expect(openPty(() => {}, 24, 80, undefined, invoke)).rejects.toThrow(
      /open_pty returned an invalid session/,
    );
  });

  it("propagates a rejected invoke", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockRejectedValue(new Error("spawn failed"));
    await expect(openPty(() => {}, 24, 80, undefined, invoke)).rejects.toThrow(
      "spawn failed",
    );
  });
});

describe("pty input/resize/close (session-scoped, trmx-74)", () => {
  it("encodePtyInput UTF-8 encodes keystrokes to a byte array", () => {
    expect(encodePtyInput("a")).toEqual([97]);
    expect(encodePtyInput("hi")).toEqual([104, 105]);
    expect(encodePtyInput("")).toEqual([]);
  });

  it("sendPtyInput invokes pty_write with the sessionId and encoded bytes", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    await sendPtyInput(3, "hi", invoke);
    expect(invoke).toHaveBeenCalledWith("pty_write", {
      sessionId: 3,
      data: [104, 105],
    });
  });

  it("sendPtyResize invokes pty_resize with the sessionId, rows and cols", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    await sendPtyResize(3, 40, 120, invoke);
    expect(invoke).toHaveBeenCalledWith("pty_resize", {
      sessionId: 3,
      rows: 40,
      cols: 120,
    });
  });

  it("closePty invokes close_pty with the sessionId", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    await closePty(5, invoke);
    expect(invoke).toHaveBeenCalledWith("close_pty", { sessionId: 5 });
  });
});

// trmx-75: the core-title mirror path — App writes each tab's EFFECTIVE title into the core
// session (the SOLE core-title writer; the poller only hints).
describe("setSessionTitle", () => {
  it("invokes set_session_title with exactly { sessionId, title }", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockResolvedValue(undefined);
    await setSessionTitle(3, "build box", invoke);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("set_session_title", {
      sessionId: 3,
      title: "build box",
    });
  });

  it("propagates a rejected invoke (App's mirror catch owns the error)", async () => {
    const invoke = vi.fn<InvokeFn>();
    invoke.mockRejectedValue(new Error("session gone"));
    await expect(setSessionTitle(3, "x", invoke)).rejects.toThrow("session gone");
  });
});

// trmx-75: the poller's foreground-process hints arrive over the event bus. Same discipline as
// onPtyExited: the payload is untrusted input (junk inert — isSessionId for the id, a string for
// the name), and the teardown is safe before the async `listen` resolves.
describe("onTitleHint", () => {
  /** A synchronous in-memory bus: listen registers immediately, unlisten removes. */
  function fakeBus() {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const bus: EventBus = {
      emit(event, payload) {
        handlers.get(event)?.forEach((h) => h(payload));
      },
      listen(event, handler) {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
        return Promise.resolve(() => set.delete(handler));
      },
    };
    return { bus, hint: (payload: unknown) => bus.emit(TITLE_HINT_EVENT, payload) };
  }

  it("dispatches sessionId + name for a valid payload", async () => {
    const { bus, hint } = fakeBus();
    const handler = vi.fn<(sessionId: number, name: string) => void>();
    onTitleHint(handler, bus);
    await Promise.resolve(); // let the listen promise settle

    hint({ sessionId: 4, name: "vim" });
    expect(handler).toHaveBeenCalledExactlyOnceWith(4, "vim");
  });

  it("passes the name RAW — sanitization is the reducer's job, not the bridge's", async () => {
    const { bus, hint } = fakeBus();
    const handler = vi.fn<(sessionId: number, name: string) => void>();
    onTitleHint(handler, bus);
    await Promise.resolve();

    hint({ sessionId: 4, name: "  spacedname  " });
    expect(handler).toHaveBeenCalledWith(4, "  spacedname  ");
  });

  it.each([
    {},
    null,
    undefined,
    "vim",
    4,
    { sessionId: 4 }, // missing name
    { name: "vim" }, // missing sessionId
    { sessionId: "4", name: "vim" }, // stringly-typed id
    { sessionId: NaN, name: "vim" }, // non-finite id
    { session_id: 4, name: "vim" }, // wrong casing — the event payload is serde camelCase
    { sessionId: 0, name: "vim" }, // ids start at 1 (backend contract)
    { sessionId: -1, name: "vim" }, // negative — no u64 maps here
    { sessionId: 1.5, name: "vim" }, // fractional — could alias another session
    { sessionId: 2 ** 53, name: "vim" }, // beyond Number.isSafeInteger — precision-lossy
    { sessionId: 4, name: 42 }, // non-string name
    { sessionId: 4, name: null }, // null name
    { sessionId: 4, name: ["vim"] }, // array name
  ])("is inert for a junk payload (%j)", async (junk) => {
    const { bus, hint } = fakeBus();
    const handler = vi.fn<(sessionId: number, name: string) => void>();
    onTitleHint(handler, bus);
    await Promise.resolve();

    hint(junk);
    expect(handler).not.toHaveBeenCalled();
    // The subscription itself must survive the junk: a valid payload still dispatches.
    hint({ sessionId: 9, name: "sleep" });
    expect(handler).toHaveBeenCalledExactlyOnceWith(9, "sleep");
  });

  it("teardown unsubscribes — later hints no longer dispatch", async () => {
    const { bus, hint } = fakeBus();
    const handler = vi.fn<(sessionId: number, name: string) => void>();
    const teardown = onTitleHint(handler, bus);
    await Promise.resolve();

    hint({ sessionId: 1, name: "vim" });
    expect(handler).toHaveBeenCalledTimes(1);
    teardown();
    hint({ sessionId: 1, name: "less" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a teardown that runs BEFORE listen resolves still unlistens (no leaked subscription)", async () => {
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    const unlisten = vi.fn();
    const bus: EventBus = {
      emit() {},
      listen: () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        }),
    };

    const teardown = onTitleHint(() => {}, bus);
    teardown(); // the subscriber is gone before the async listen ever resolved
    resolveListen?.(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("dispatches nothing after teardown even if the bus still fires (torn-down guard)", async () => {
    // A bus whose unlisten is a no-op — the `live` guard alone must keep the handler silent.
    const registered: Array<(payload: unknown) => void> = [];
    const bus: EventBus = {
      emit(_event, payload) {
        registered.forEach((h) => h(payload));
      },
      listen(_event, handler) {
        registered.push(handler);
        return Promise.resolve(() => {});
      },
    };
    const handler = vi.fn<(sessionId: number, name: string) => void>();
    const teardown = onTitleHint(handler, bus);
    await Promise.resolve();

    teardown();
    bus.emit(TITLE_HINT_EVENT, { sessionId: 3, name: "vim" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("swallows a bus without a runtime (listen rejects) and the teardown stays safe", async () => {
    const bus: EventBus = {
      emit() {},
      listen: () => Promise.reject(new Error("no Tauri runtime")),
    };
    const teardown = onTitleHint(() => {}, bus);
    await Promise.resolve();
    expect(() => teardown()).not.toThrow();
  });
});

// trmx-74: the backend announces a child's exit over the event bus; the payload is untrusted input
// (cursorSettings-style guard — junk must be inert), and the teardown must be safe even when it
// runs before the async `listen` resolves (realObserveSettings pattern).
describe("onPtyExited", () => {
  /** A synchronous in-memory bus: listen registers immediately, unlisten removes. */
  function fakeBus() {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const bus: EventBus = {
      emit(event, payload) {
        handlers.get(event)?.forEach((h) => h(payload));
      },
      listen(event, handler) {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
        return Promise.resolve(() => set.delete(handler));
      },
    };
    return { bus, exit: (payload: unknown) => bus.emit(PTY_EXITED_EVENT, payload) };
  }

  it("dispatches the sessionId for a valid payload", async () => {
    const { bus, exit } = fakeBus();
    const handler = vi.fn<(sessionId: number) => void>();
    onPtyExited(handler, bus);
    await Promise.resolve(); // let the listen promise settle

    exit({ sessionId: 4 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(4);
  });

  it.each([
    {},
    null,
    undefined,
    "4",
    4,
    { sessionId: "4" },
    { sessionId: NaN },
    { session_id: 4 }, // wrong casing — Tauri events carry the serialized camelCase payload
    { sessionId: 0 }, // ids start at 1 (backend contract)
    { sessionId: -1 }, // negative
    { sessionId: 1.5 }, // fractional
    { sessionId: 2 ** 53 }, // beyond Number.isSafeInteger
  ])("is inert for a junk payload (%j)", async (junk) => {
    const { bus, exit } = fakeBus();
    const handler = vi.fn<(sessionId: number) => void>();
    onPtyExited(handler, bus);
    await Promise.resolve();

    exit(junk);
    expect(handler).not.toHaveBeenCalled();
    // The subscription itself must survive the junk: a valid payload still dispatches.
    exit({ sessionId: 9 });
    expect(handler).toHaveBeenCalledWith(9);
  });

  it("teardown unsubscribes — later exits no longer dispatch", async () => {
    const { bus, exit } = fakeBus();
    const handler = vi.fn<(sessionId: number) => void>();
    const teardown = onPtyExited(handler, bus);
    await Promise.resolve();

    exit({ sessionId: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    teardown();
    exit({ sessionId: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a teardown that runs BEFORE listen resolves still unlistens (no leaked subscription)", async () => {
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    const unlisten = vi.fn();
    const bus: EventBus = {
      emit() {},
      listen: () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        }),
    };

    const teardown = onPtyExited(() => {}, bus);
    teardown(); // the subscriber is gone before the async listen ever resolved
    resolveListen?.(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("dispatches nothing after teardown even if the bus still fires (torn-down guard)", async () => {
    // A bus whose unlisten is a no-op — the `live` guard alone must keep the handler silent.
    const registered: Array<(payload: unknown) => void> = [];
    const bus: EventBus = {
      emit(_event, payload) {
        registered.forEach((h) => h(payload));
      },
      listen(_event, handler) {
        registered.push(handler);
        return Promise.resolve(() => {});
      },
    };
    const handler = vi.fn<(sessionId: number) => void>();
    const teardown = onPtyExited(handler, bus);
    await Promise.resolve();

    teardown();
    bus.emit(PTY_EXITED_EVENT, { sessionId: 3 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("swallows a bus without a runtime (listen rejects) and the teardown stays safe", async () => {
    const bus: EventBus = {
      emit() {},
      listen: () => Promise.reject(new Error("no Tauri runtime")),
    };
    const teardown = onPtyExited(() => {}, bus);
    await Promise.resolve();
    expect(() => teardown()).not.toThrow();
  });
});

// trmx-91: the backend announces a session's foreground busy<->idle transitions over the event bus.
// Same discipline as onTitleHint/onPtyExited: the payload is untrusted input, guarded by the pure
// parseActivityPayload (junk inert), and the teardown is safe before the async `listen` resolves.
describe("onSessionActivity", () => {
  /** A synchronous in-memory bus: listen registers immediately, unlisten removes. */
  function fakeBus() {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const bus: EventBus = {
      emit(event, payload) {
        handlers.get(event)?.forEach((h) => h(payload));
      },
      listen(event, handler) {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
        return Promise.resolve(() => set.delete(handler));
      },
    };
    return { bus, activity: (payload: unknown) => bus.emit(SESSION_ACTIVITY_EVENT, payload) };
  }

  it("dispatches sessionId + busy for a valid payload (both boolean values)", async () => {
    const { bus, activity } = fakeBus();
    const handler = vi.fn<(sessionId: number, busy: boolean) => void>();
    onSessionActivity(handler, bus);
    await Promise.resolve(); // let the listen promise settle

    activity({ sessionId: 4, busy: true });
    expect(handler).toHaveBeenCalledExactlyOnceWith(4, true);
    activity({ sessionId: 4, busy: false });
    expect(handler).toHaveBeenLastCalledWith(4, false);
  });

  it.each([
    {},
    null,
    undefined,
    "busy",
    4,
    true,
    { sessionId: 4 }, // missing busy
    { busy: true }, // missing sessionId
    { sessionId: "4", busy: true }, // stringly-typed id
    { sessionId: NaN, busy: true }, // non-finite id
    { sessionId: 1.5, busy: true }, // fractional — parseActivityPayload requires an integer
    { session_id: 4, busy: true }, // wrong casing — the event payload is serde camelCase
    { sessionId: 4, busy: "true" }, // stringly-typed busy
    { sessionId: 4, busy: 1 }, // numeric busy
    { sessionId: 4, busy: null }, // null busy
  ])("is inert for a junk payload (%j)", async (junk) => {
    const { bus, activity } = fakeBus();
    const handler = vi.fn<(sessionId: number, busy: boolean) => void>();
    onSessionActivity(handler, bus);
    await Promise.resolve();

    activity(junk);
    expect(handler).not.toHaveBeenCalled();
    // The subscription itself must survive the junk: a valid payload still dispatches.
    activity({ sessionId: 9, busy: true });
    expect(handler).toHaveBeenCalledExactlyOnceWith(9, true);
  });

  it("teardown unsubscribes — later activity no longer dispatches", async () => {
    const { bus, activity } = fakeBus();
    const handler = vi.fn<(sessionId: number, busy: boolean) => void>();
    const teardown = onSessionActivity(handler, bus);
    await Promise.resolve();

    activity({ sessionId: 1, busy: true });
    expect(handler).toHaveBeenCalledTimes(1);
    teardown();
    activity({ sessionId: 1, busy: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a teardown that runs BEFORE listen resolves still unlistens (no leaked subscription)", async () => {
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    const unlisten = vi.fn();
    const bus: EventBus = {
      emit() {},
      listen: () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        }),
    };

    const teardown = onSessionActivity(() => {}, bus);
    teardown(); // the subscriber is gone before the async listen ever resolved
    resolveListen?.(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("dispatches nothing after teardown even if the bus still fires (torn-down guard)", async () => {
    // A bus whose unlisten is a no-op — the `live` guard alone must keep the handler silent.
    const registered: Array<(payload: unknown) => void> = [];
    const bus: EventBus = {
      emit(_event, payload) {
        registered.forEach((h) => h(payload));
      },
      listen(_event, handler) {
        registered.push(handler);
        return Promise.resolve(() => {});
      },
    };
    const handler = vi.fn<(sessionId: number, busy: boolean) => void>();
    const teardown = onSessionActivity(handler, bus);
    await Promise.resolve();

    teardown();
    bus.emit(SESSION_ACTIVITY_EVENT, { sessionId: 3, busy: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("swallows a bus without a runtime (listen rejects) and the teardown stays safe", async () => {
    const bus: EventBus = {
      emit() {},
      listen: () => Promise.reject(new Error("no Tauri runtime")),
    };
    const teardown = onSessionActivity(() => {}, bus);
    await Promise.resolve();
    expect(() => teardown()).not.toThrow();
  });
});
