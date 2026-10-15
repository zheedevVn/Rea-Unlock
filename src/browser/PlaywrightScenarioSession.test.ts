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
    | ((event: { method: string; params: unknown }) => void)
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
    close: vi.fn(async () => undefined),
  };
  return { cleanup, page, storage: mocks.storage };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.policySend.mockReset();
  mocks.policyTransportClose.mockReset();
  mocks.policyEvent = undefined;
  mocks.policySend.mockImplementation(async (method: string) =>
    method === "Page.addScriptToEvaluateOnNewDocument"
      ? { identifier: "owned-policy-script" }
      : {},
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
    if (terminal === "closed page") page.isClosed = () => true;
    else
      mocks.policyEvent?.({
        method: "Target.detachedFromTarget",
        params: { sessionId: "policy-session" },
      });
    await expect(session.close()).resolves.toBe("disconnected-external");
    expect(
      mocks.policySend.mock.calls.some(
        ([method]) => method === "Target.detachFromTarget",
      ),
    ).toBe(false);
    expect(mocks.policyTransportClose).toHaveBeenCalledTimes(1);
  },
);

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
  const failure = new Error("registration restoration failed");
  page.evaluate.mockRejectedValueOnce(failure);
  await expect(session.close()).rejects.toBe(failure);
  expect(cleanup.close).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBe("disconnected-external");
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
    return {};
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
  expect(page.evaluate.mock.calls.at(-1)?.[0]).toContain(
    "policy restoration could not be confirmed",
  );
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
