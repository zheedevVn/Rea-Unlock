import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { _electron as electron } from "playwright-core";

import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type {
  CanonicalElectronActiveObservationInput,
  ElectronActiveObservationPort,
} from "../application/javascript/ElectronActiveObservationPort.js";
import type { ElectronActiveObservationResult } from "../domain/javascript/electronActiveObservation.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  cleanupOwnedProcessGroup,
  cleanupWindowsProcessTree,
  verifyNoTokenOwnedProcesses,
  type OwnedProcessGroup,
  type ProcessCleanupResult,
  type ProcessLineageObservation,
  type OwnershipSweepUnverifiedProcess,
} from "../process/ProcessOwnership.js";
import {
  observeOwnedProcessLineage,
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost,
} from "../process/ProcessOwnershipObservation.js";
import { selectCapturedProcessGroupIds } from "../process/ProcessOwnershipProcessTree.js";
import {
  runElectronActions,
  readApplicationState,
  readFinalApplicationState,
  runWithExecutionLimits,
} from "./PlaywrightElectronActiveActions.js";
import { projectElectronActiveCapture } from "./PlaywrightElectronActiveProjection.js";
import { readElectronFuseImage } from "../electron/ElectronFuseReader.js";
import { assertNodeCliInspectArgumentsSupported } from "./PlaywrightElectronActiveFuses.js";

const OPERATION = "capture_electron_scenario" as const;
const STARTUP_TIMEOUT_MS = 60_000;

import { PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY } from "./providerIdentities.js";

const hookPath = fileURLToPath(
  new URL("../../scripts/electron-active-hook.cjs", import.meta.url),
);

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type ElectronPaths = {
  readonly executable: string;
  readonly application: string;
  readonly root: string;
};

/** Launch an owned Electron application through the official Playwright API. */
export class PlaywrightElectronActiveProvider implements ElectronActiveObservationPort {
  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>>,
    // Load Playwright only when a capture launches; MCP startup stays off its module graph.
    private readonly launch: typeof electron.launch = async (options) =>
      (await import("playwright-core"))._electron.launch(options),
    private readonly readFuseImage: typeof readElectronFuseImage = readElectronFuseImage,
  ) {}

  identity(): ProviderIdentity {
    return PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY;
  }

  async capture(
    input: CanonicalElectronActiveObservationInput,
    options: ExecutionOptions = {},
  ): Promise<Result<ElectronActiveObservationResult, AnalysisError>> {
    let application: ElectronApplication | undefined;
    let ownership: OwnedProcessGroup | undefined;
    let lineage: ProcessLineageObservation | undefined;
    let capture: ElectronActiveObservationResult | undefined;
    let paths: ElectronPaths | undefined;
    let initialState:
      | Awaited<ReturnType<typeof readApplicationState>>
      | undefined;
    let actions: ElectronActiveObservationResult["actions"] = [];
    let outcome: Result<ElectronActiveObservationResult, AnalysisError>;
    const runId = randomUUID();
    try {
      if (options.signal?.aborted === true)
        throw new BrowserObservationError(OPERATION, "cancelled");
      await prepareProcessOwnershipInspection(options.signal);
      const startupDeadline = performance.now() + STARTUP_TIMEOUT_MS;
      paths = {
        executable: input.executable_path,
        application: input.application_path,
        root: input.application_root,
      };
      await runWithExecutionLimits(
        assertNodeCliInspectArgumentsSupported(paths.executable, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          readFuseImage: this.readFuseImage,
        }),
        options.signal,
        startupDeadline,
      );
      const captureBaseline =
        await systemProcessOwnershipHost.captureBaseline?.(options.signal);
      if (options.signal?.aborted)
        throw new BrowserObservationError(OPERATION, "cancelled");
      const launchOptions: Parameters<typeof electron.launch>[0] = {
        executablePath: paths.executable,
        cwd: paths.root,
        env: safeElectronEnvironment(this.environment, runId),
        args: ["-r", hookPath, paths.application, ...input.args],
        timeout: Math.max(1, startupDeadline - performance.now()),
      };
      application = await containLaunchRejections(() =>
        this.launch(launchOptions),
      );
      const leaderPid = application.process().pid;
      if (
        typeof leaderPid !== "number" ||
        !Number.isSafeInteger(leaderPid) ||
        leaderPid <= 0
      )
        throw new BrowserObservationError(
          OPERATION,
          "process_ownership_unavailable",
        );
      ownership = {
        runId,
        leaderPid,
        processGroupId: leaderPid,
        expectedParentPid: process.pid,
        expectedCommand: paths.executable,
        sweepTokenOwnedProcesses: true,
        ...(captureBaseline === undefined ? {} : { captureBaseline }),
      };
      lineage = await observeOwnedProcessLineage(ownership);
      initialState = await runWithExecutionLimits(
        readApplicationState(application),
        options.signal,
        startupDeadline,
      );
      actions = await runElectronActions(application, input, options);
      const state = await readFinalApplicationState(
        application,
        options.signal,
      );
      capture = projectElectronActiveCapture(paths, actions, state);
      // Preserve a cancellation already observed before finalization so a
      // later cleanup failure keeps its cause. Late cancellation is checked below.
      outcome = options.signal?.aborted
        ? err(cancelledCapture(capture, options.signal.reason))
        : ok(capture);
    } catch (cause: unknown) {
      if (paths !== undefined && initialState !== undefined) {
        const retainedCapture = projectElectronActiveCapture(
          paths,
          actions,
          initialState,
        );
        capture = {
          ...retainedCapture,
          limitations: [
            ...retainedCapture.limitations,
            `Capture stopped after the initial pre-action snapshot: ${cause instanceof Error ? cause.message : String(cause)}. Final Windows, metrics, IPC, and timeline state is unknown; the retained snapshot may omit action effects.`,
          ],
        };
      }
      if (options.signal?.aborted === true)
        outcome = err(
          new BrowserObservationError(OPERATION, "cancelled", {
            ...cancellationCause(cause, options.signal),
            ...(capture === undefined
              ? {}
              : {
                  partialObservation: {
                    kind: "electron-active-observation" as const,
                    capture,
                  },
                }),
          }),
        );
      else {
        const error = providerError(cause);
        if (capture !== undefined)
          error.retainPartialObservation({
            kind: "electron-active-observation",
            capture,
          });
        outcome = err(error);
      }
    }
    if (application !== undefined) {
      if (ownership !== undefined) {
        const currentLineage = await observeOwnedProcessLineage(ownership);
        if (currentLineage.status === "verified" || lineage === undefined)
          lineage = currentLineage;
      }
      let closeError: unknown;
      try {
        await runWithExecutionLimits(
          application.close(),
          undefined,
          performance.now() + 5_000,
        );
      } catch (cause: unknown) {
        closeError = cause;
      }
      const cleanup =
        ownership === undefined
          ? ({
              cleaned: false,
              reason: "owned Electron process identity was unavailable",
            } satisfies ProcessCleanupResult)
          : await cleanupElectronProcesses(ownership, lineage);
      if (!cleanup.cleaned)
        return err(
          new BrowserObservationError(OPERATION, "cleanup_failed", {
            cause: outcome.ok ? new Error(cleanup.reason) : outcome.error,
            detail: `Electron cleanup could not be verified: ${cleanup.reason}.${capture !== undefined ? " Collected observations are retained in partial_observation." : ""}${outcome.ok ? "" : ` Capture also failed: ${outcome.error.message}.`} Inspect the reported process resources before launching another capture.`,
            cleanup: {
              reason: cleanup.reason,
              resources:
                ownership === undefined
                  ? ["owned_process_group"]
                  : [
                      "owned_process_group",
                      `run:${ownership.runId}`,
                      `process-group:${String(ownership.processGroupId)}`,
                    ],
            },
            ...(capture !== undefined
              ? {
                  partialObservation: {
                    kind: "electron-active-observation" as const,
                    capture: {
                      ...capture,
                      application: {
                        ...capture.application,
                        cleanup: "unverified" as const,
                      },
                    },
                  },
                }
              : {}),
          }),
        );
      if (closeError !== undefined)
        return err(
          new BrowserObservationError(OPERATION, "cleanup_failed", {
            cause: outcome.ok ? closeError : outcome.error,
            detail: `Electron transport teardown failed after process cleanup: ${closeError instanceof Error ? closeError.message : String(closeError)}.${capture !== undefined ? " Collected observations are retained in partial_observation." : ""}${outcome.ok ? "" : ` Capture also failed: ${outcome.error.message}.`}`,
            ...(capture !== undefined
              ? {
                  partialObservation: {
                    kind: "electron-active-observation" as const,
                    capture,
                  },
                }
              : {}),
          }),
        );
      if (outcome.ok && cleanup.unverified !== undefined)
        outcome = ok({
          ...outcome.value,
          limitations: [
            ...outcome.value.limitations,
            ...cleanup.unverified.map(
              ({ pid, diagnostic }) =>
                `Ownership of unrelated process ${String(pid)} could not be verified; it was left untouched: ${diagnostic}`,
            ),
          ],
        });
    }
    // Cleanup failures returned above keep precedence; a completed capture
    // observed under late cancellation is retained as partial Evidence.
    if (outcome.ok && options.signal?.aborted === true)
      return err(cancelledCapture(outcome.value, options.signal.reason));
    return outcome;
  }
}

const cancelledCapture = (
  capture: ElectronActiveObservationResult,
  reason: unknown,
): BrowserObservationError =>
  new BrowserObservationError(OPERATION, "cancelled", {
    cause: reason,
    partialObservation: { kind: "electron-active-observation", capture },
  });

/**
 * A cancellation wrapper stands in for the caller's abort reason and keeps its
 * producer diagnostics; any other failure observed with cancellation stays the
 * primary cause.
 */
const cancellationCause = (
  cause: unknown,
  signal: AbortSignal,
): {
  readonly cause: unknown;
  readonly diagnostics?: AnalysisError["diagnostics"];
} =>
  cause instanceof AnalysisCancelledError ||
  (cause instanceof AnalysisError && cause.userCategory === "cancelled")
    ? {
        cause: signal.reason,
        ...(cause.diagnostics === undefined
          ? {}
          : { diagnostics: cause.diagnostics }),
      }
    : { cause };

/** Clean up an Electron launch. Windows signals a process only after lineage is verified. */
export const cleanupElectronProcesses = async (
  ownership: OwnedProcessGroup,
  lineage: ProcessLineageObservation | undefined,
  host: {
    readonly platform: NodeJS.Platform;
    readonly terminateTree: typeof cleanupWindowsProcessTree;
  } = {
    platform: process.platform,
    terminateTree: cleanupWindowsProcessTree,
  },
): Promise<ProcessCleanupResult> => {
  if (lineage?.status !== "verified") {
    if (host.platform !== "win32") {
      const root = await cleanupOwnedProcessGroup(ownership);
      if (!root.cleaned) return root;
    }
    return {
      cleaned: false,
      reason: `${lineage?.reason ?? "owned Electron lineage was not observed"}; helper cleanup was not proven`,
    };
  }
  if (host.platform === "win32") {
    const root = await host.terminateTree(ownership.leaderPid);
    if (!root.cleaned) return root;
    for (const descendant of lineage.lineage.descendants) {
      const result = await host.terminateTree(descendant.pid);
      if (!result.cleaned) return result;
    }
    return root;
  }
  const groupIds = selectCapturedProcessGroupIds(
    ownership.leaderPid,
    lineage.lineage.descendants.map(({ pid, processGroupId }) => ({
      pid,
      process_group_id: processGroupId,
    })),
  );
  let signaled = false;
  const unverified: OwnershipSweepUnverifiedProcess[] = [];
  for (const processGroupId of groupIds) {
    const cleanupOwnership: OwnedProcessGroup =
      processGroupId === ownership.processGroupId
        ? { ...ownership, leaderPid: processGroupId, processGroupId }
        : {
            runId: ownership.runId,
            leaderPid: processGroupId,
            processGroupId,
          };
    const result = await cleanupOwnedProcessGroup(cleanupOwnership);
    if (!result.cleaned) return result;
    signaled ||= result.signaled;
    unverified.push(...(result.unverified ?? []));
  }
  const remaining = await verifyNoTokenOwnedProcesses(
    ownership.runId,
    undefined,
    ownership.captureBaseline,
    {
      leaderPid: ownership.leaderPid,
      processGroupId: ownership.processGroupId,
      ...(ownership.sampledProcessGroupIds === undefined
        ? {}
        : { sampledProcessGroupIds: ownership.sampledProcessGroupIds }),
    },
  );
  if (!remaining.cleaned) return remaining;
  unverified.push(...(remaining.unverified ?? []));
  return {
    cleaned: true,
    signaled,
    ...(unverified.length === 0
      ? {}
      : {
          unverified: [
            ...new Map(
              unverified.map((item) => [
                `${String(item.pid)}:${item.diagnostic}`,
                item,
              ]),
            ).values(),
          ],
        }),
  };
};

export const safeElectronEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  runId: string,
  platform = process.platform,
): Record<string, string> =>
  Object.fromEntries([
    ...[
      "HOME",
      "LANG",
      "PATH",
      "TMP",
      "TMPDIR",
      "USER",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      ...(platform === "win32"
        ? [
            "SYSTEMROOT",
            "TEMP",
            "APPDATA",
            "LOCALAPPDATA",
            "USERPROFILE",
            "COMSPEC",
            "PATHEXT",
            "PROGRAMDATA",
            "ALLUSERSPROFILE",
            "USERNAME",
            "SYSTEMDRIVE",
            "HOMEDRIVE",
            "HOMEPATH",
          ]
        : []),
    ]
      .map((name) => [name, environment[name]] as const)
      .filter(
        (entry): entry is readonly [string, string] => entry[1] !== undefined,
      ),
    ["REA_PROCESS_RUN_ID", runId] as const,
  ]);

const PLAYWRIGHT_INTERNAL_FRAME = /playwright-core[\\/]lib[\\/]/;
interface LaunchRejectionScope {
  failure?: unknown;
}
const activeLaunches = new Set<LaunchRejectionScope>();
const heldLaunchRejections = new Map<
  Promise<unknown>,
  {
    readonly reason: Error;
    readonly candidates: Set<LaunchRejectionScope>;
    readonly hadExternalListener: boolean;
  }
>();

const holdLaunchRejection = (
  reason: unknown,
  promise: Promise<unknown>,
): void => {
  if (
    !(reason instanceof Error) ||
    !PLAYWRIGHT_INTERNAL_FRAME.test(reason.stack ?? "")
  )
    throw reason;
  if (!heldLaunchRejections.has(promise))
    heldLaunchRejections.set(promise, {
      reason,
      candidates: new Set(activeLaunches),
      hadExternalListener: process
        .listeners("unhandledRejection")
        .some((listener) => listener !== holdLaunchRejection),
    });
};

const forwardLaunchRejection = (
  reason: Error,
  hadExternalListener: boolean,
): void => {
  // Listeners present at the original event already observed it. When the
  // holding listener was the only listener, restore Node's fatal behavior.
  if (!hadExternalListener)
    process.nextTick(() => {
      throw reason;
    });
};

/** Playwright leaves rejected launch promises unhandled; absorb only those that repeat this launch's failure. */
const containLaunchRejections = async <T>(
  launch: () => Promise<T>,
): Promise<T> => {
  const scope: LaunchRejectionScope = {};
  if (activeLaunches.size === 0)
    process.on("unhandledRejection", holdLaunchRejection);
  activeLaunches.add(scope);
  try {
    return await launch();
  } catch (cause: unknown) {
    scope.failure = cause;
    throw cause;
  } finally {
    await new Promise<void>((resolve) => setImmediate(resolve));
    activeLaunches.delete(scope);
    if (activeLaunches.size === 0)
      process.off("unhandledRejection", holdLaunchRejection);
    for (const [
      promise,
      { reason, candidates, hadExternalListener },
    ] of heldLaunchRejections) {
      if (!candidates.delete(scope)) continue;
      if (
        scope.failure instanceof Error &&
        reason.message !== "" &&
        scope.failure.message.includes(reason.message)
      )
        heldLaunchRejections.delete(promise);
      else if (candidates.size === 0) {
        heldLaunchRejections.delete(promise);
        forwardLaunchRejection(reason, hadExternalListener);
      }
    }
  }
};

const providerError = (cause: unknown): AnalysisError =>
  cause instanceof AnalysisError
    ? cause
    : new ProviderAdapterError(
        PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY.id,
        OPERATION,
        {
          cause,
          diagnostics: {
            message: cause instanceof Error ? cause.message : String(cause),
          },
        },
      );
