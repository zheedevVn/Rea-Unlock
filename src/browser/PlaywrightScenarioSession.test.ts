import { EventEmitter } from "node:events";

import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openBrowser: vi.fn(),
  storage: undefined as
    | {
        initialize: ReturnType<typeof vi.fn>;
        settle: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      }
    | undefined,
  finishEvents: vi.fn(),
  policySend: vi.fn(),
  policyTransportClose: vi.fn(),
  policyEvent: undefined as
    | ((event: { method: string; params: unknown; sessionId?: string }) => void)
    | undefined,
}));

vi.mock("./CdpTargetSession.js", () => ({
  openCdpEndpoint: async () => ({
    discovery: { targets: [{ id: "target" }] },
    connection: {
      send: mocks.policySend,
      onEvent: (listener: typeof mocks.policyEvent) => {
        mocks.policyEvent = listener;
        return () => undefined;
      },
      close: mocks.policyTransportClose,
    },
  }),
  attachCdpTargetSession: async (connection: unknown) => ({
    connection,
    sessionId: "policy-session",
  }),
}));

vi.mock("./PlaywrightScenarioBrowser.js", () => ({
  openPlaywrightScenarioBrowser: mocks.openBrowser,
  failBrowserScenarioOperation: async (
    cleanup: () => Promise<void>,
    cause: unknown,
  ) => {
    try {
      await cleanup();
    } catch (cleanupCause: unknown) {
      throw new AggregateError([cause, cleanupCause]);
    }
    throw cause;
  },
}));

vi.mock("./PlaywrightScenarioStorage.js", () => ({
  PlaywrightScenarioStorage: {
    create: vi.fn(async () => mocks.storage),
  },
}));

vi.mock("./PlaywrightScenarioEvents.js", () => ({
  PlaywrightScenarioEvents: class {
    finish() {
      mocks.finishEvents();
    }

    result() {
      return {
        retained: 0,
        dropped: 0,
        items: [],
        omissions: {
          by_kind: [],
          network_transactions: [],
          network_transaction_range: null,
        },
      };
    }

    limitations() {
      return [];
    }

    setStep() {}

    nextSequence() {
      return 1;
    }

    lastSequence() {
      return 0;
    }
  },
}));

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { PlaywrightScenarioSession } from "./PlaywrightScenarioSession.js";

const scenario = browserScenarioSchema.parse({
  browser: { mode: "launch", executable_path: process.execPath },
  start_url: { url: "https://storage.example.test/" },
  actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  storage: {
    local_storage: [
      {
        origin: "https://storage.example.test",
        entries: [{ name: "seed", value: { source: "literal", value: "v" } }],
      },
    ],
  },
});

const fixture = () => {
  const page = Object.assign(new EventEmitter(), {
    url: () => "about:blank",
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async (_script: unknown): Promise<unknown> => null),
    addInitScript: vi.fn(async (_script: unknown) => undefined),
    context: () => context,
    frames: () => [page],
    mainFrame: () => page,
    isDetached: () => false,
    isClosed: (): boolean => false,
    waitForLoadState: vi.fn(async () => undefined),
  });
  const context = Object.assign(new EventEmitter(), {
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    addCookies: vi.fn(async () => undefined),
    browser: () => browser,
  });
  const browser = Object.assign(new EventEmitter(), {
    version: () => "Chrome 154",
  });
  let browserClosed = false;
  const close = vi.fn(async (finishEvents?: () => Promise<void>) => {
    await finishEvents?.();
    browserClosed = true;
  });
  const cleanup = {
    close,
    get browserClosed() {
      return browserClosed;
    },
  };
  mocks.openBrowser.mockResolvedValue({
    page,
    context,
    browser,
    cleanup,
    profilePath: "/tmp/profile",
  });
  mocks.storage = {
    initialize: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    close: vi.fn(async (stopLoading = false) => ({
      loadingStopped: stopLoading,
    })),
  };
  return { cleanup, page, storage: mocks.storage };
};

const policyResponse = (method: string): unknown =>
  method === "Page.addScriptToEvaluateOnNewDocument"
    ? { identifier: "owned-policy-script" }
    : method === "Runtime.evaluate"
      ? { result: { value: null } }
      : {};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.policySend.mockReset();
  mocks.policyTransportClose.mockReset();
  mocks.policyEvent = undefined;
  mocks.policySend.mockImplementation(async (method: string) =>
    policyResponse(method),
  );
  mocks.policyTransportClose.mockResolvedValue(undefined);
});

it("stops attached navigation without storage and retries rejected policy cleanup", async () => {
  const { cleanup } = fixture();
  mocks.storage = undefined;
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
    storage: {},
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  const failure = new Error("stopLoading rejected");
  mocks.policySend.mockRejectedValueOnce(failure);
  await expect(session.close(true)).rejects.toBe(failure);
  expect(cleanup.close).not.toHaveBeenCalled();
  await expect(session.close(true)).resolves.toBe("disconnected-external");
  expect(
    mocks.policySend.mock.calls.filter(
      ([method]) => method === "Page.stopLoading",
    ),
  ).toHaveLength(2);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("assigns attached navigation stopping to the storage owner once", async () => {
  const { cleanup, storage } = fixture();
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});

  await expect(session.close(true)).resolves.toBe("disconnected-external");
  expect(storage?.close).toHaveBeenCalledWith(true);
  expect(
    mocks.policySend.mock.calls.filter(
      ([method]) => method === "Page.stopLoading",
    ),
  ).toHaveLength(0);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("transfers attached navigation stopping after storage cleanup fails", async () => {
  const { cleanup, storage } = fixture();
  const storageFailure = new Error("storage stop unconfirmed");
  storage?.close.mockRejectedValueOnce(storageFailure);
  const policyFailure = new Error("policy stop unconfirmed");
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  mocks.policySend.mockRejectedValueOnce(policyFailure);

  await expect(session.close(true)).rejects.toMatchObject({
    errors: [policyFailure, storageFailure],
  });
  expect(cleanup.close).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(storage?.close).toHaveBeenCalledWith(true);
  expect(
    mocks.policySend.mock.calls.filter(
      ([method]) => method === "Page.stopLoading",
    ),
  ).toHaveLength(2);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("transfers a late stop request after storage has already released", async () => {
  const { cleanup, storage } = fixture();
  const cancellation = new AbortController();
  storage?.close.mockResolvedValue({ loadingStopped: false });
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });
  const session = await PlaywrightScenarioSession.open(
    attached,
    {},
    {
      signal: cancellation.signal,
    },
  );
  const restorationFailure = new Error("registration restoration failed");
  let failRestoration = true;
  mocks.policySend.mockImplementation(async (method: string) => {
    if (method === "Runtime.evaluate" && failRestoration) {
      failRestoration = false;
      throw restorationFailure;
    }
    return policyResponse(method);
  });

  await expect(session.close(false)).rejects.toBe(restorationFailure);
  expect(cleanup.close).not.toHaveBeenCalled();
  cancellation.abort();
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(storage?.close.mock.calls).toEqual([[false], [true]]);
  expect(
    mocks.policySend.mock.calls.filter(
      ([method]) => method === "Page.stopLoading",
    ),
  ).toHaveLength(1);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("retains transferred navigation stopping after setup cleanup fails", async () => {
  const { cleanup, storage } = fixture();
  const cancellation = new AbortController();
  const setupFailure = new Error("storage initialization failed");
  storage?.initialize.mockImplementationOnce(async () => {
    cancellation.abort();
    throw setupFailure;
  });
  storage?.close.mockRejectedValueOnce(new Error("storage stop unconfirmed"));
  const policyFailure = new Error("policy stop unconfirmed");
  let failPolicyStop = true;
  mocks.policySend.mockImplementation(async (method: string) => {
    if (method === "Page.stopLoading" && failPolicyStop) {
      failPolicyStop = false;
      throw policyFailure;
    }
    return policyResponse(method);
  });
  let retainedCleanup: (() => Promise<unknown>) | undefined;
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });

  await expect(
    PlaywrightScenarioSession.open(
      attached,
      {},
      {
        signal: cancellation.signal,
        retainCleanup: (close) => {
          retainedCleanup = close;
        },
      },
    ),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(cleanup.close).not.toHaveBeenCalled();
  if (retainedCleanup === undefined)
    throw new Error("failed cleanup was not retained");
  await expect(retainedCleanup()).resolves.toBeUndefined();
  expect(
    mocks.policySend.mock.calls.filter(
      ([method]) => method === "Page.stopLoading",
    ),
  ).toHaveLength(2);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("allows the bounded policy cleanup chain to cross one second", async () => {
  const { cleanup } = fixture();
  mocks.storage = undefined;
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
    storage: {},
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  let releaseStop: () => void = () => undefined;
  let stopStarted: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const started = new Promise<void>((resolve) => {
    stopStarted = resolve;
  });
  mocks.policySend.mockImplementation(async (method: string) => {
    if (method === "Page.stopLoading") {
      stopStarted();
      await stopped;
    }
    return policyResponse(method);
  });

  vi.useFakeTimers();
  try {
    let settled = false;
    const closing = session.close(true).then(
      () => {
        settled = true;
        return { ok: true as const };
      },
      (cause: unknown) => {
        settled = true;
        return { ok: false as const, cause };
      },
    );
    await started;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(settled).toBe(false);
    releaseStop();
    await expect(closing).resolves.toEqual({ ok: true });
  } finally {
    vi.useRealTimers();
  }
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("does not await policy initialization after its child target detaches", async () => {
  const { cleanup } = fixture();
  mocks.storage = undefined;
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
    storage: {},
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  let childStarted: () => void = () => undefined;
  let releaseChild: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    childStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  mocks.policySend.mockImplementation(
    async (method: string, _params: unknown, target: string) => {
      if (method === "Page.enable" && target === "child-session") {
        childStarted();
        await held;
      }
      return policyResponse(method);
    },
  );
  mocks.policyEvent?.({
    method: "Target.attachedToTarget",
    params: {
      sessionId: "child-session",
      targetInfo: { type: "iframe" },
    },
    sessionId: "policy-session",
  });
  await started;
  const closing = session.close();
  mocks.policyEvent?.({
    method: "Target.detachedFromTarget",
    params: { sessionId: "child-session" },
  });
  try {
    await expect(closing).resolves.toBe("disconnected-external");
  } finally {
    releaseChild();
  }
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("skips policy restoration for a child without a committed document", async () => {
  const { cleanup, page } = fixture();
  mocks.storage = undefined;
  const pendingChild = {
    url: () => "",
    isDetached: () => false,
    evaluate: vi.fn(() => new Promise(() => undefined)),
  };
  const session = await PlaywrightScenarioSession.open(
    browserScenarioSchema.parse({
      ...scenario,
      browser: {
        mode: "connect",
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target",
      },
      environment: { service_workers: "block" },
      storage: {},
    }),
    {},
    {},
  );
  page.frames = () => [page, pendingChild as unknown as typeof page];

  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(pendingChild.evaluate).not.toHaveBeenCalled();
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("rejects an init script accepted by CDP when the live realm is unprotected", async () => {
  const { page, cleanup } = fixture();
  page.evaluate
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce("policy_unprotected");
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });
  await expect(
    PlaywrightScenarioSession.open(attached, {}, {}),
  ).rejects.toMatchObject({
    reason: "target_not_allowed",
  });
  expect(
    mocks.policySend.mock.calls.some(
      ([method]) => method === "Page.addScriptToEvaluateOnNewDocument",
    ),
  ).toBe(true);
  expect(
    mocks.policySend.mock.calls.some(
      ([method]) => method === "Page.removeScriptToEvaluateOnNewDocument",
    ),
  ).toBe(true);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("restores an owned policy script after later setup fails", async () => {
  const { cleanup } = fixture();
  const setupFailure = new Error("auto-attach rejected");
  mocks.policySend.mockImplementation(async (method: string) => {
    if (method === "Target.setAutoAttach") throw setupFailure;
    return policyResponse(method);
  });
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });

  await expect(PlaywrightScenarioSession.open(attached, {}, {})).rejects.toBe(
    setupFailure,
  );
  expect(mocks.policySend).toHaveBeenCalledWith(
    "Page.removeScriptToEvaluateOnNewDocument",
    { identifier: "owned-policy-script" },
    "policy-session",
  );
  expect(
    mocks.policySend.mock.calls.some(
      ([method]) => method === "Runtime.evaluate",
    ),
  ).toBe(true);
  expect(mocks.policyTransportClose).toHaveBeenCalledTimes(1);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("retains an owned script identifier after rejected removal", async () => {
  const { cleanup } = fixture();
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  const failure = new Error("removeScript rejected");
  mocks.policySend.mockRejectedValueOnce(failure);
  await expect(session.close()).rejects.toBe(failure);
  expect(cleanup.close).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBe("disconnected-external");
  const removals = mocks.policySend.mock.calls.filter(
    ([method]) => method === "Page.removeScriptToEvaluateOnNewDocument",
  );
  expect(removals).toHaveLength(2);
  expect(
    removals.every(([, params]) => params.identifier === "owned-policy-script"),
  ).toBe(true);
});

it("retries transport close without detaching an already released policy session", async () => {
  fixture();
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  const failure = new Error("transport close rejected");
  mocks.policyTransportClose.mockRejectedValueOnce(failure);
  await expect(session.close()).rejects.toBe(failure);
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(
    mocks.policySend.mock.calls.filter(
      ([method]) => method === "Target.detachFromTarget",
    ),
  ).toHaveLength(1);
  expect(mocks.policyTransportClose).toHaveBeenCalledTimes(2);
});

it.each(["closed page", "detached target"])(
  "releases its policy transport after a %s",
  async (terminal) => {
    const { page } = fixture();
    mocks.storage = undefined;
    const attached = browserScenarioSchema.parse({
      ...scenario,
      browser: {
        mode: "connect",
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target",
      },
      environment: { service_workers: "block" },
      storage: {},
    });
    const session = await PlaywrightScenarioSession.open(attached, {}, {});
    if (terminal === "closed page") page.isClosed = () => true;
    else
      mocks.policyEvent?.({
        method: "Target.detachedFromTarget",
        params: { sessionId: "policy-session" },
      });
    await expect(session.close(true)).resolves.toBe("disconnected-external");
    expect(
      mocks.policySend.mock.calls.some(
        ([method]) => method === "Target.detachFromTarget",
      ),
    ).toBe(false);
    expect(mocks.policyTransportClose).toHaveBeenCalledTimes(1);
    if (terminal === "detached target") {
      expect(page.evaluate).toHaveBeenCalledWith("globalThis.stop()");
      expect(page.evaluate).toHaveBeenCalledWith(
        expect.stringContaining("policy_owned"),
      );
    }
  },
);

it("retains a detached policy connection until the main realm is restored", async () => {
  const { cleanup, page } = fixture();
  mocks.storage = undefined;
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
    storage: {},
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  mocks.policyEvent?.({
    method: "Target.detachedFromTarget",
    params: { sessionId: "policy-session" },
  });
  page.evaluate
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce("policy_owned")
    .mockResolvedValueOnce(null);

  await expect(session.close(true)).rejects.toThrow(
    "service-worker policy restoration could not be confirmed",
  );
  expect(cleanup.close).not.toHaveBeenCalled();
  expect(mocks.policyTransportClose).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(page.evaluate).toHaveBeenCalledWith("globalThis.stop()");
  expect(
    page.evaluate.mock.calls.filter(
      ([script]) => script === "globalThis.stop()",
    ),
  ).toHaveLength(1);
  expect(mocks.policyTransportClose).toHaveBeenCalledTimes(1);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("uses browser disconnect as terminal storage release after detach failure", async () => {
  const { cleanup, storage } = fixture();
  const detachFailure = new Error("CDP detach rejected");
  storage.close.mockRejectedValueOnce(detachFailure);
  const session = await PlaywrightScenarioSession.open(scenario, {}, {});

  await expect(session.close()).resolves.toBe("terminated-owned-process");
  expect(storage.close).toHaveBeenCalledTimes(1);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
  expect(mocks.finishEvents).toHaveBeenCalledTimes(1);
  await expect(session.close()).resolves.toBe("terminated-owned-process");
  expect(storage.close).toHaveBeenCalledTimes(1);
});

it("leaves attached service-worker state alone when the policy allows it", async () => {
  const { cleanup, page } = fixture();
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "allow" },
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});

  expect(mocks.openBrowser).toHaveBeenCalledWith(
    attached,
    {},
    expect.any(Object),
  );
  expect(page.evaluate).not.toHaveBeenCalled();
  expect(page.addInitScript).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("blocks new attached service-worker registration without removing existing registrations", async () => {
  const { cleanup, page } = fixture();
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});

  expect(page.evaluate).toHaveBeenCalledTimes(3);
  const injection = mocks.policySend.mock.calls.find(
    ([method]) => method === "Page.addScriptToEvaluateOnNewDocument",
  )?.[1];
  expect(injection.source).toContain(
    "service workers are blocked by scenario policy",
  );
  expect(injection.source).not.toContain("getRegistrations");
  expect(injection.source).not.toContain("unregister");
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(mocks.policySend).toHaveBeenCalledWith(
    "Page.removeScriptToEvaluateOnNewDocument",
    { identifier: "owned-policy-script" },
    "policy-session",
  );
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("retains the attached connection when registration restoration fails", async () => {
  const { cleanup } = fixture();
  mocks.storage = undefined;
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
    storage: {},
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});
  const failure = new Error("registration restoration failed");
  let failRestoration = true;
  mocks.policySend.mockImplementation(async (method: string) => {
    if (method === "Runtime.evaluate" && failRestoration) {
      failRestoration = false;
      throw failure;
    }
    return policyResponse(method);
  });
  await expect(session.close(true)).rejects.toBe(failure);
  expect(cleanup.close).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(
    mocks.policySend.mock.calls.filter(
      ([method]) => method === "Page.stopLoading",
    ),
  ).toHaveLength(1);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
  await expect(session.close()).resolves.toBe("disconnected-external");
});

it("cancels a stalled policy preflight without allowing late setup", async () => {
  const { cleanup, page } = fixture();
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  page.evaluate.mockImplementationOnce(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return false;
  });
  const cancellation = new AbortController();
  const opening = PlaywrightScenarioSession.open(
    browserScenarioSchema.parse({
      ...scenario,
      browser: {
        mode: "connect",
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target",
      },
      environment: { service_workers: "block" },
    }),
    {},
    { signal: cancellation.signal },
  );
  const outcome = expect(opening).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
  });
  await started;
  cancellation.abort();
  await outcome;
  expect(cleanup.close).toHaveBeenCalledTimes(1);
  expect(cleanup.close.mock.calls[0]).toHaveLength(1);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mocks.policySend).not.toHaveBeenCalled();
});

it("waits for a pending registration installation before cancelled cleanup", async () => {
  const { cleanup, page } = fixture();
  let releaseInstallation: () => void = () => undefined;
  let installationStarted: () => void = () => undefined;
  const installed = new Promise<void>((resolve) => {
    releaseInstallation = resolve;
  });
  const started = new Promise<void>((resolve) => {
    installationStarted = resolve;
  });
  mocks.policySend.mockImplementation(async (method: string) => {
    if (method === "Page.addScriptToEvaluateOnNewDocument") {
      installationStarted();
      await installed;
      return { identifier: "owned-policy-script" };
    }
    return policyResponse(method);
  });
  const cancellation = new AbortController();
  const opening = PlaywrightScenarioSession.open(
    browserScenarioSchema.parse({
      ...scenario,
      browser: {
        mode: "connect",
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "target",
      },
      environment: { service_workers: "block" },
    }),
    {},
    { signal: cancellation.signal },
  );
  const outcome = expect(opening).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
  });
  await started;
  cancellation.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(cleanup.close).not.toHaveBeenCalled();
  expect(page.evaluate).toHaveBeenCalledTimes(1);
  releaseInstallation();
  await outcome;
  const restoration = mocks.policySend.mock.calls.find(
    ([method]) => method === "Runtime.evaluate",
  )?.[1];
  expect(restoration).toMatchObject({
    expression: expect.stringContaining("policy_owned"),
  });
  expect(mocks.policySend).toHaveBeenCalledWith(
    "Page.stopLoading",
    {},
    "policy-session",
  );
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("rejects attached block when caller-owned registrations already exist", async () => {
  const { cleanup, page } = fixture();
  page.evaluate.mockResolvedValueOnce("service_worker_blocked");
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });

  await expect(
    PlaywrightScenarioSession.open(attached, {}, {}),
  ).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "service_worker_blocked",
  });
  expect(page.addInitScript).not.toHaveBeenCalled();
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("preserves both cleanup failures and retries retained owners", async () => {
  const { cleanup, storage } = fixture();
  const detachFailure = new Error("CDP detach rejected");
  const transportFailure = new Error("Playwright transport close failed");
  storage.close
    .mockRejectedValueOnce(detachFailure)
    .mockResolvedValueOnce(undefined);
  cleanup.close
    .mockRejectedValueOnce(transportFailure)
    .mockImplementationOnce(async (finishEvents?: () => Promise<void>) => {
      await finishEvents?.();
    });
  const session = await PlaywrightScenarioSession.open(scenario, {}, {});

  let failure: unknown;
  try {
    await session.close();
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    detachFailure,
    transportFailure,
  ]);
  expect(storage.close).toHaveBeenCalledTimes(1);
  expect(cleanup.close).toHaveBeenCalledTimes(1);

  await expect(session.close()).resolves.toBe("terminated-owned-process");
  expect(storage.close).toHaveBeenCalledTimes(2);
  expect(cleanup.close).toHaveBeenCalledTimes(2);
});
