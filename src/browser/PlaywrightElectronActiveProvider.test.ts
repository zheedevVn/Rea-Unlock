import { afterEach, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  OBSIDIAN_FUSE_BYTES,
  thinFuseImage,
} from "../../tests/fixtures/electron/fuseImage.js";

import * as processOwnership from "../process/ProcessOwnership.js";
import * as ownershipObservation from "../process/ProcessOwnershipObservation.js";
import * as electronActions from "./PlaywrightElectronActiveActions.js";
import { electronActiveObservationInputSchema } from "../domain/javascript/electronActiveObservation.js";
import type { OwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  cleanupElectronProcesses,
  PlaywrightElectronActiveProvider,
  safeElectronEnvironment,
} from "./PlaywrightElectronActiveProvider.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("passes the selected environment and ownership token to Electron launch", async () => {
  vi.stubEnv("LANG", "ambient-language");
  let launchedEnvironment: unknown;
  const provider = new PlaywrightElectronActiveProvider(
    {
      LANG: "selected-language",
      PATH: "/selected/bin",
      REA_PRIVATE_VALUE: "not-a-launch-setting",
    },
    async (options) => {
      launchedEnvironment = options?.env;
      throw new Error("launch boundary reached");
    },
  );
  const result = await provider.capture({
    ...electronActiveObservationInputSchema.parse({
      executable_path: process.execPath,
      application_path: process.execPath,
    }),
    application_root: dirname(process.execPath),
  });

  expect(result.ok).toBe(false);
  expect(launchedEnvironment).toEqual({
    LANG: "selected-language",
    PATH: "/selected/bin",
    REA_PROCESS_RUN_ID: expect.any(String),
  });
});

it("passes required Windows runtime variables without inheriting unrelated values", () => {
  expect(
    safeElectronEnvironment(
      {
        SYSTEMROOT: "C:\\Windows",
        LOCALAPPDATA: "C:\\Users\\analyst\\AppData\\Local",
        USERPROFILE: "C:\\Users\\analyst",
        APP_SECRET: "must-not-pass",
      },
      "run-id",
      "win32",
    ),
  ).toEqual({
    SYSTEMROOT: "C:\\Windows",
    LOCALAPPDATA: "C:\\Users\\analyst\\AppData\\Local",
    USERPROFILE: "C:\\Users\\analyst",
    REA_PROCESS_RUN_ID: "run-id",
  });
});

const ownership = {
  runId: "run",
  leaderPid: 4242,
  processGroupId: 4242,
  expectedParentPid: 1,
} satisfies OwnedProcessGroup;

const emptyHookSnapshot = () => ({
  events: [],
  retention_budget_bytes: 0,
  estimated_retained_bytes: 0,
  event_serialized_byte_upper_bound: 0,
  retained: 0,
  dropped: 0,
  dropped_ipc: 0,
  dropped_runtime: 0,
  dropped_event_families: [],
  dropped_event_roles: [],
  observed: 0,
  observed_ipc: 0,
  observed_runtime: 0,
  hook_error: false,
});

it.each([
  "owned launcher is not live",
  "process table permission denied",
  "process ownership did not match",
])(
  "does not signal a Windows Electron PID when lineage is unavailable: %s",
  async (reason) => {
    const terminateTree = vi.fn(async () => ({
      cleaned: true as const,
      signaled: true,
    }));
    const result = await cleanupElectronProcesses(
      ownership,
      {
        status: "unavailable",
        observedAt: "2026-10-10T00:00:00.000Z",
        runId: ownership.runId,
        launcherPid: ownership.leaderPid,
        processGroupId: ownership.processGroupId,
        reason,
      },
      { platform: "win32", terminateTree },
    );

    expect(terminateTree).not.toHaveBeenCalled();
    expect(result).toEqual({
      cleaned: false,
      reason: `${reason}; helper cleanup was not proven`,
    });
  },
);

it("does not signal an unobserved Windows Electron lineage", async () => {
  const terminateTree = vi.fn();
  expect(
    await cleanupElectronProcesses(ownership, undefined, {
      platform: "win32",
      terminateTree,
    }),
  ).toEqual({
    cleaned: false,
    reason:
      "owned Electron lineage was not observed; helper cleanup was not proven",
  });
  expect(terminateTree).not.toHaveBeenCalled();
});

it.each([0, 1])(
  "preserves a Windows termination failure at tree index %i",
  async (failedIndex) => {
    const failure = { cleaned: false as const, reason: "termination denied" };
    const terminateTree = vi
      .fn<typeof processOwnership.cleanupWindowsProcessTree>()
      .mockResolvedValue({ cleaned: true, signaled: true });
    terminateTree.mockImplementationOnce(async () =>
      failedIndex === 0 ? failure : { cleaned: true, signaled: true },
    );
    if (failedIndex === 1) terminateTree.mockResolvedValueOnce(failure);
    const result = await cleanupElectronProcesses(
      ownership,
      {
        status: "verified",
        observedAt: "2026-10-10T00:00:00.000Z",
        lineage: {
          runId: ownership.runId,
          launcherPid: ownership.leaderPid,
          launcherParentPid: 1,
          processGroupId: ownership.processGroupId,
          descendants: [
            {
              pid: 4343,
              parentPid: ownership.leaderPid,
              processGroupId: ownership.processGroupId,
            },
          ],
        },
      },
      { platform: "win32", terminateTree },
    );
    expect(result).toBe(failure);
    expect(terminateTree).toHaveBeenCalledTimes(failedIndex + 1);
  },
);

it("signals a Windows Electron tree only after lineage is verified", async () => {
  const terminateTree = vi.fn(async () => ({
    cleaned: true as const,
    signaled: true,
  }));
  const result = await cleanupElectronProcesses(
    ownership,
    {
      status: "verified",
      observedAt: "2026-10-10T00:00:00.000Z",
      lineage: {
        runId: ownership.runId,
        launcherPid: ownership.leaderPid,
        launcherParentPid: 1,
        processGroupId: ownership.processGroupId,
        descendants: [
          {
            pid: 4343,
            parentPid: ownership.leaderPid,
            processGroupId: ownership.processGroupId,
          },
        ],
      },
    },
    { platform: "win32", terminateTree },
  );

  expect(terminateTree).toHaveBeenNthCalledWith(1, 4242);
  expect(terminateTree).toHaveBeenNthCalledWith(2, 4343);
  expect(result).toEqual({ cleaned: true, signaled: true });
});

it("retains the partial capture without taskkill when Windows lineage is unavailable", async () => {
  // Exercise the Windows decision branch; this is not native Windows coverage.
  // The injected unavailable observation keeps this independent of host PID reuse.
  vi.spyOn(
    ownershipObservation,
    "observeOwnedProcessLineage",
  ).mockResolvedValue({
    status: "unavailable",
    observedAt: "2026-10-10T00:00:00.000Z",
    runId: "fixture-run",
    launcherPid: 424242,
    processGroupId: 424242,
    reason: "process table permission denied",
  });
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  const terminateTree = vi
    .spyOn(processOwnership, "cleanupWindowsProcessTree")
    .mockResolvedValue({ cleaned: true, signaled: true });
  const state = {
    windows: [],
    metrics: [],
    electronVersion: "44.0.0",
    hookSnapshot: emptyHookSnapshot(),
  };
  vi.spyOn(electronActions, "readApplicationState").mockResolvedValue(state);
  vi.spyOn(electronActions, "readFinalApplicationState").mockResolvedValue(
    state,
  );
  const application = {
    process: () => ({ pid: 424242 }),
    close: vi.fn(async () => undefined),
    windows: () => [],
  };
  const provider = new PlaywrightElectronActiveProvider(
    {},
    async () =>
      application as unknown as Awaited<
        ReturnType<typeof import("playwright-core")._electron.launch>
      >,
  );

  try {
    const result = await provider.capture({
      ...electronActiveObservationInputSchema.parse({
        executable_path: process.execPath,
        application_path: process.execPath,
      }),
      application_root: dirname(process.execPath),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected unverified cleanup to fail");
    expect(terminateTree).not.toHaveBeenCalled();
    expect(result.error).toMatchObject({
      _tag: "BrowserObservationError",
      reason: "cleanup_failed",
      cleanup: {
        reason:
          "process table permission denied; helper cleanup was not proven",
      },
      partialObservation: {
        kind: "electron-active-observation",
        capture: {
          application: {
            cleanup: "unverified",
          },
        },
      },
    });
  } finally {
    if (originalPlatform !== undefined)
      Object.defineProperty(process, "platform", originalPlatform);
  }
});

it("retains the initial snapshot when the final state read fails", async () => {
  const initialState = {
    windows: [],
    metrics: [],
    electronVersion: "44.0.0",
    hookSnapshot: emptyHookSnapshot(),
  };
  vi.spyOn(electronActions, "readApplicationState").mockResolvedValueOnce(
    initialState,
  );
  vi.spyOn(electronActions, "readFinalApplicationState").mockRejectedValueOnce(
    new Error("final renderer state unavailable"),
  );
  const application = {
    process: () => ({ pid: 424242 }),
    close: vi.fn(async () => undefined),
    windows: () => [],
  };
  const provider = new PlaywrightElectronActiveProvider(
    {},
    async () =>
      application as unknown as Awaited<
        ReturnType<typeof import("playwright-core")._electron.launch>
      >,
  );

  const result = await provider.capture({
    ...electronActiveObservationInputSchema.parse({
      executable_path: process.execPath,
      application_path: process.execPath,
      actions: [],
    }),
    application_root: dirname(process.execPath),
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected final state capture to fail");
  const partialObservation = result.error.partialObservation;
  expect(partialObservation).toMatchObject({
    kind: "electron-active-observation",
    capture: {
      application: { electron_version: "44.0.0" },
      limitations: expect.arrayContaining([
        expect.stringContaining("initial pre-action snapshot"),
      ]),
    },
  });
});

it("rejects active capture before launch when EnableNodeCliInspectArguments fuse is disabled", async () => {
  const root = await createTestTempDirectory("rea-active-provider-fuse-");
  const disabledBinary = join(root, "disabled-electron");
  await writeFile(disabledBinary, thinFuseImage(OBSIDIAN_FUSE_BYTES).bytes);

  const launchSpy = vi.fn(async () => {
    throw new Error("launch should not be called when fuse is disabled");
  });

  const provider = new PlaywrightElectronActiveProvider({}, launchSpy);

  const result = await provider.capture({
    ...electronActiveObservationInputSchema.parse({
      executable_path: disabledBinary,
      application_path: disabledBinary,
    }),
    application_root: root,
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected capture to fail");
  expect(launchSpy).not.toHaveBeenCalled();
  expect(result.error).toMatchObject({
    _tag: "AnalysisUnsupportedTargetError",
    operation: "capture_electron_scenario",
    path: disabledBinary,
    message: expect.stringContaining("EnableNodeCliInspectArguments"),
    remediationAction: expect.stringContaining("inspect_electron_page"),
  });
});

const stubVerifiedElectronCleanup = () => {
  vi.spyOn(
    ownershipObservation,
    "observeOwnedProcessLineage",
  ).mockImplementation(async (group) => ({
    status: "verified",
    observedAt: "2026-10-10T00:00:00.000Z",
    lineage: {
      runId: group.runId,
      launcherPid: group.leaderPid,
      launcherParentPid: process.pid,
      processGroupId: group.processGroupId,
      descendants: [],
    },
  }));
  return [
    vi
      .spyOn(processOwnership, "cleanupWindowsProcessTree")
      .mockResolvedValue({ cleaned: true, signaled: true }),
    vi
      .spyOn(processOwnership, "cleanupOwnedProcessGroup")
      .mockResolvedValue({ cleaned: true, signaled: true }),
    vi
      .spyOn(processOwnership, "verifyNoTokenOwnedProcesses")
      .mockResolvedValue({ cleaned: true, signaled: false }),
  ];
};

/** Run a capture whose test doubles abort `controller` at a chosen phase. */
const captureWithController = async (
  controller: AbortController,
  application: Record<string, unknown>,
  actions: unknown[],
) => {
  const provider = new PlaywrightElectronActiveProvider(
    {},
    async () =>
      application as unknown as Awaited<
        ReturnType<typeof import("playwright-core")._electron.launch>
      >,
  );
  return provider.capture(
    {
      ...electronActiveObservationInputSchema.parse({
        executable_path: process.execPath,
        application_path: process.execPath,
        actions,
      }),
      application_root: dirname(process.execPath),
    },
    { signal: controller.signal },
  );
};

it("cancels a windowless wait action and cleans up the owned application", async () => {
  const cleanupSpies = stubVerifiedElectronCleanup();
  const state = {
    windows: [],
    metrics: [],
    electronVersion: "44.0.0",
    hookSnapshot: emptyHookSnapshot(),
  };
  vi.spyOn(electronActions, "readApplicationState").mockResolvedValue(state);
  vi.spyOn(electronActions, "readFinalApplicationState").mockResolvedValue(
    state,
  );
  const controller = new AbortController();
  const reason = new Error("caller-reason");
  const application = {
    process: () => ({ pid: 424242 }),
    close: vi.fn(async () => undefined),
    windows: () => [],
    firstWindow: vi.fn(() => {
      queueMicrotask(() => controller.abort(reason));
      return new Promise<never>(() => undefined);
    }),
  };

  const result = await captureWithController(controller, application, [
    { step_id: "settle", kind: "wait", duration_ms: 10 },
  ]);

  expect(application.firstWindow).toHaveBeenCalledOnce();
  expect(application.close).toHaveBeenCalledOnce();
  expect(cleanupSpies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the capture to be cancelled");
  expect(result.error).toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cancelled",
    partialObservation: {
      kind: "electron-active-observation",
      capture: {
        actions: [{ step_id: "settle", kind: "wait", status: "cancelled" }],
      },
    },
  });
  expect(result.error.cause).toBe(reason);
});

it("cancels a pending initial state read and cleans up the owned application", async () => {
  const cleanupSpies = stubVerifiedElectronCleanup();
  const controller = new AbortController();
  const reason = new Error("caller-reason");
  vi.spyOn(electronActions, "readApplicationState").mockImplementation(() => {
    queueMicrotask(() => controller.abort(reason));
    return new Promise<never>(() => undefined);
  });
  const application = {
    process: () => ({ pid: 424242 }),
    close: vi.fn(async () => undefined),
    windows: () => [],
  };

  const result = await captureWithController(controller, application, []);

  expect(application.close).toHaveBeenCalledOnce();
  expect(cleanupSpies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the capture to be cancelled");
  expect(result.error).toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cancelled",
  });
  expect(result.error.cause).toBe(reason);
});

it("observes an initial state read started after cancellation and rejected by cleanup", async () => {
  const cleanupSpies = stubVerifiedElectronCleanup();
  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", recordUnhandled);
  try {
    const controller = new AbortController();
    const reason = new Error("caller-reason");
    let rejectReads = (_cause: Error): void => undefined;
    const closed = new Promise<never>((_, reject) => {
      rejectReads = reject;
    });
    // Plain functions keep spy bookkeeping from observing the abandoned read.
    const application = {
      process: () => ({ pid: 424242 }),
      evaluate: () => {
        controller.abort(reason);
        return closed;
      },
      close: vi.fn(async () => {
        rejectReads(
          new Error("Target page, context or browser has been closed"),
        );
      }),
      windows: () => [],
    };

    const result = await captureWithController(controller, application, []);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(application.close).toHaveBeenCalledOnce();
    expect(cleanupSpies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
    expect(unhandled).toEqual([]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the capture to be cancelled");
    expect(result.error).toMatchObject({
      _tag: "BrowserObservationError",
      reason: "cancelled",
    });
    expect(result.error.cause).toBe(reason);
  } finally {
    process.off("unhandledRejection", recordUnhandled);
  }
});

it("keeps a failure observed with cancellation as the cancellation cause", async () => {
  stubVerifiedElectronCleanup();
  const state = {
    windows: [],
    metrics: [],
    electronVersion: "44.0.0",
    hookSnapshot: emptyHookSnapshot(),
  };
  vi.spyOn(electronActions, "readApplicationState").mockResolvedValue(state);
  const controller = new AbortController();
  const failure = new Error("final state read failed");
  vi.spyOn(electronActions, "readFinalApplicationState").mockImplementation(
    async () => {
      controller.abort(new Error("caller-reason"));
      throw failure;
    },
  );
  const application = {
    process: () => ({ pid: 424242 }),
    close: vi.fn(async () => undefined),
    windows: () => [],
  };

  const result = await captureWithController(controller, application, []);

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the capture to be cancelled");
  expect(result.error).toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cancelled",
    partialObservation: { kind: "electron-active-observation" },
  });
  expect(result.error.cause).toBe(failure);
});

it("reports an expired final state grace period as the caller's cancellation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    stubVerifiedElectronCleanup();
    const controller = new AbortController();
    const reason = new Error("caller-reason");
    vi.spyOn(electronActions, "readApplicationState").mockResolvedValueOnce({
      windows: [],
      metrics: [],
      electronVersion: "44.0.0",
      hookSnapshot: emptyHookSnapshot(),
    });
    // The real final read reaches these evaluations, which never settle.
    const evaluate = vi.fn(() => {
      queueMicrotask(() => controller.abort(reason));
      return new Promise<never>(() => undefined);
    });
    const application = {
      process: () => ({ pid: 424242 }),
      evaluate,
      close: vi.fn(async () => undefined),
      windows: () => [],
    };

    const capture = captureWithController(controller, application, []);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await capture;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the capture to be cancelled");
    expect(result.error).toMatchObject({
      _tag: "BrowserObservationError",
      reason: "cancelled",
      diagnostics: {
        final_state_read: "cancellation_grace_expired",
        cancellation_grace_ms: 5_000,
      },
      partialObservation: {
        kind: "electron-active-observation",
        capture: {
          limitations: expect.arrayContaining([
            expect.stringContaining("initial pre-action snapshot"),
          ]),
        },
      },
    });
    expect(result.error.cause).toBe(reason);
  } finally {
    vi.useRealTimers();
  }
});

const stubCompletedCapture = () => {
  const state = {
    windows: [],
    metrics: [],
    electronVersion: "44.0.0",
    hookSnapshot: emptyHookSnapshot(),
  };
  vi.spyOn(electronActions, "readApplicationState").mockResolvedValue(state);
  vi.spyOn(electronActions, "readFinalApplicationState").mockResolvedValue(
    state,
  );
};

it("cancels a completed capture when cancellation arrives during application close", async () => {
  stubVerifiedElectronCleanup();
  stubCompletedCapture();
  const controller = new AbortController();
  const reason = new Error("SIGTERM during close");
  const application = {
    process: () => ({ pid: 424242 }),
    close: vi.fn(async () => {
      controller.abort(reason);
    }),
    windows: () => [],
  };

  const result = await captureWithController(controller, application, []);

  expect(application.close).toHaveBeenCalledOnce();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the capture to be cancelled");
  expect(result.error).toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cancelled",
    partialObservation: {
      kind: "electron-active-observation",
      capture: { application: { electron_version: "44.0.0" } },
    },
  });
  expect(result.error.cause).toBe(reason);
});

it("cancels a completed capture when cancellation arrives during process cleanup", async () => {
  stubVerifiedElectronCleanup();
  stubCompletedCapture();
  const controller = new AbortController();
  const reason = new Error("SIGTERM during process cleanup");
  // The POSIX path ends with the token sweep; Windows ends with tree termination.
  vi.spyOn(processOwnership, "verifyNoTokenOwnedProcesses").mockImplementation(
    async () => {
      controller.abort(reason);
      return {
        cleaned: true,
        signaled: false,
        unverified: [{ pid: 777, diagnostic: "command line unavailable" }],
      };
    },
  );
  vi.spyOn(processOwnership, "cleanupWindowsProcessTree").mockImplementation(
    async () => {
      controller.abort(reason);
      return { cleaned: true, signaled: true };
    },
  );
  const application = {
    process: () => ({ pid: 424242 }),
    close: vi.fn(async () => undefined),
    windows: () => [],
  };

  const result = await captureWithController(controller, application, []);

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the capture to be cancelled");
  expect(result.error).toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cancelled",
    partialObservation: {
      kind: "electron-active-observation",
      capture: { application: { electron_version: "44.0.0" } },
    },
  });
  expect(result.error.cause).toBe(reason);
});

it("keeps cleanup failure precedence over cancellation observed during cleanup", async () => {
  stubVerifiedElectronCleanup();
  stubCompletedCapture();
  const controller = new AbortController();
  const failed = async () => {
    controller.abort(new Error("SIGTERM during process cleanup"));
    return { cleaned: false as const, reason: "process group still alive" };
  };
  vi.spyOn(processOwnership, "cleanupOwnedProcessGroup").mockImplementation(
    failed,
  );
  vi.spyOn(processOwnership, "cleanupWindowsProcessTree").mockImplementation(
    failed,
  );
  const application = {
    process: () => ({ pid: 424242 }),
    close: vi.fn(async () => undefined),
    windows: () => [],
  };

  const result = await captureWithController(controller, application, []);

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected cleanup to fail");
  expect(result.error).toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cleanup_failed",
    cleanup: { reason: "process group still alive" },
    partialObservation: {
      kind: "electron-active-observation",
      capture: { application: { cleanup: "unverified" } },
    },
  });
});

it.each(["process", "transport"] as const)(
  "preserves cancellation that preceded a %s cleanup failure",
  async (failure) => {
    stubVerifiedElectronCleanup();
    stubCompletedCapture();
    const controller = new AbortController();
    const reason = new Error("SIGTERM before cleanup");
    vi.spyOn(electronActions, "runElectronActions").mockImplementation(
      async () => {
        controller.abort(reason);
        return [];
      },
    );
    if (failure === "process") {
      const failed = async () => ({
        cleaned: false as const,
        reason: "process group still alive",
      });
      vi.spyOn(processOwnership, "cleanupOwnedProcessGroup").mockImplementation(
        failed,
      );
      vi.spyOn(
        processOwnership,
        "cleanupWindowsProcessTree",
      ).mockImplementation(failed);
    }
    const application = {
      process: () => ({ pid: 424242 }),
      close: vi.fn(async () => {
        if (failure === "transport")
          throw new Error("transport still connected");
      }),
      windows: () => [],
    };

    const result = await captureWithController(controller, application, []);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected incomplete cleanup");
    expect(result.error).toMatchObject({
      _tag: "BrowserObservationError",
      reason: "cleanup_failed",
      userCategory: "cancelled",
      cause: {
        _tag: "BrowserObservationError",
        reason: "cancelled",
        cause: reason,
      },
      partialObservation: {
        kind: "electron-active-observation",
      },
    });
    expect(result.error.userMessage).toContain(
      failure === "process"
        ? "process group still alive"
        : "transport still connected",
    );
    expect(application.close).toHaveBeenCalledOnce();
  },
);
