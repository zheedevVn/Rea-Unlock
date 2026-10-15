import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { hashStableFile } from "../filesystem/StableFileHash.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import { prepareProcessOwnershipInspection } from "../process/ProcessOwnershipObservation.js";
import type {
  OwnedProviderProcessSpawnOptions,
  ProviderProcessSnapshot,
  SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  kunaChildEnvironment,
  type KunaInstallation,
} from "./KunaInstallation.js";
import {
  parseKunaExportSummary,
  parseKunaInventory,
  scanKunaProjectSource,
  type KunaExportSummary,
  type KunaInventoryFunction,
  type KunaProjectFunction,
} from "./KunaProjectFiles.js";
import { KUNA_PROVIDER_ID } from "./KunaRelease.js";

/** Operation name every export and cache failure reports. */
export const KUNA_EXPORT_OPERATION = "kuna:decompile-project";

/** Kuna prints one summary line per export; notes on a large image stay far below this. */
const DIAGNOSTIC_BYTES = 8 * 1024 * 1024;

/**
 * `kuna functions --json` costs ~210 bytes per function; this admits about
 * 600,000 functions, above the 392,814 of the largest image Kuna documents.
 */
const INVENTORY_BYTES = 128 * 1024 * 1024;

const INVENTORY_FILE = "functions.json";

/** Identity of one file an export consists of. */
export interface KunaExportFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** The files of one export, by role. */
export interface KunaExportFiles {
  readonly c: KunaExportFile;
  readonly h: KunaExportFile;
  readonly asm: KunaExportFile;
  readonly readme: KunaExportFile;
  readonly inventory: KunaExportFile;
}

/** One validated export: its files, Kuna's counts and the facts parsed from them. */
export interface KunaExport {
  readonly files: KunaExportFiles;
  readonly summary: KunaExportSummary;
  /** Decompiled function blocks in `.c` order. */
  readonly functions: readonly KunaProjectFunction[];
  /** Every callable entry Kuna found, including imports it does not decompile. */
  readonly inventory: readonly KunaInventoryFunction[];
}

/** The step an export is in; Kuna itself reports no progress until it finishes. */
export interface KunaExportStatus {
  readonly phase: "inventory" | "decompiling" | "sealing";
  /** Callable entries found by the inventory, once known. */
  readonly inventoryFunctions: number | null;
}

/** Test seam for the owned process launcher; production uses the default. */
export type KunaProcessLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/**
 * How an export ended. `retained` means an owned Kuna process could not be
 * proven stopped, so it may still write into the workspace, which therefore
 * stays with the caller's cleanup owner.
 */
export type KunaExportOutcome =
  | {
      readonly kind: "done";
      readonly result: Result<KunaExport, AnalysisError>;
    }
  | { readonly kind: "retained"; readonly error: ProviderCleanupError };

/** One export of a target into a private workspace. */
export interface KunaExportRequest {
  readonly installation: KunaInstallation;
  /** Caller-selected target path; Kuna decompiles a verified copy of it. */
  readonly targetPath: string;
  readonly targetSha256: string;
  /** Private directory for the copy, Kuna's temporary files and its output. */
  readonly workspace: string;
  /** Directory, inside the workspace, that receives the export's files. */
  readonly output: string;
  readonly signal: AbortSignal;
  readonly onStatus: (status: KunaExportStatus) => void;
  readonly launcher?: KunaProcessLauncher | undefined;
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR");

/** Map an unexpected failure to a typed one, preferring cancellation. */
export const kunaExportFailure = (
  cause: unknown,
  signal: AbortSignal,
): AnalysisError => {
  if (signal.aborted)
    return new AnalysisCancelledError(KUNA_EXPORT_OPERATION, { cause });
  if (cause instanceof AnalysisError) return cause;
  return new ProviderAdapterError(KUNA_PROVIDER_ID, KUNA_EXPORT_OPERATION, {
    cause,
    userMessage: `Kuna project cache failed: ${message(cause)}`,
  });
};

const unusable = (reason: string): KunaExportOutcome => ({
  kind: "done",
  result: err(
    new ProviderAdapterError(KUNA_PROVIDER_ID, KUNA_EXPORT_OPERATION, {
      userMessage: `Kuna's project export is not usable: ${reason}`,
    }),
  ),
});

/** Verify the selected installation at each execution and publication boundary. */
const verifyKunaExecutable = async (
  installation: KunaInstallation,
  signal: AbortSignal,
): Promise<Result<null, ProviderAdapterError>> => {
  const executable = await hashStableFile(installation.executable, signal);
  if (executable.sha256 === installation.sha256) return ok(null);
  return err(
    new ProviderAdapterError(KUNA_PROVIDER_ID, KUNA_EXPORT_OPERATION, {
      userMessage: `${installation.executable} changed after readiness inspection; reopen the target so REA probes the current Kuna executable.`,
      diagnostics: {
        expected_sha256: installation.sha256,
        observed_sha256: executable.sha256,
      },
    }),
  );
};

/**
 * Inventory and export one target with Kuna, then validate the result.
 *
 * Kuna runs on a copy hashed while copying, so the export always describes
 * the digest the caller selected. Both Kuna runs share one deadline.
 */
export const exportKunaProject = async (
  request: KunaExportRequest,
): Promise<KunaExportOutcome> => {
  const { installation, signal } = request;
  const { configuration } = installation;
  const deadline = Date.now() + configuration.projectTimeoutMs;
  const input = join(request.workspace, "input", basename(request.targetPath));
  await mkdir(join(request.workspace, "input"), { mode: 0o700 });
  await mkdir(request.output, { recursive: true, mode: 0o700 });

  const copied = await copyAndHash(request.targetPath, input, signal);
  if (copied !== request.targetSha256)
    return {
      kind: "done",
      result: err(
        new AnalysisArtifactChangedError(
          KUNA_EXPORT_OPERATION,
          request.targetPath,
          "the target no longer matches the digest selected for analysis",
        ),
      ),
    };
  await prepareProcessOwnershipInspection(signal);
  const run = (arguments_: readonly string[], diagnosticBytes: number) =>
    runKuna(request, arguments_, { deadline, diagnosticBytes });

  request.onStatus({ phase: "inventory", inventoryFunctions: null });
  const listed = await run(["functions", input, "--json"], INVENTORY_BYTES);
  if (!listed.ok) return listed.outcome;
  const inventory = parseKunaInventory(listed.snapshot.stdout.text);
  if (!inventory.ok) return unusable(inventory.error);
  if (listed.snapshot.stdout.invalidUtf8 === true)
    return unusable("the function inventory is not valid UTF-8");
  await writeFile(
    join(request.output, INVENTORY_FILE),
    listed.snapshot.stdout.text,
    { mode: 0o600 },
  );

  request.onStatus({
    phase: "decompiling",
    inventoryFunctions: inventory.value.length,
  });
  const exported = await run(
    [
      "decompile-project",
      input,
      "-o",
      request.output,
      "--jobs",
      String(configuration.jobs),
    ],
    DIAGNOSTIC_BYTES,
  );
  if (!exported.ok) return exported.outcome;

  request.onStatus({
    phase: "sealing",
    inventoryFunctions: inventory.value.length,
  });
  const summary = parseKunaExportSummary(exported.snapshot.stdout.text);
  if (summary === undefined)
    return unusable(
      "Kuna did not print its `functions: N ok, M failed` summary.",
    );
  const stem = basename(request.targetPath);
  const names = {
    c: `${stem}.c`,
    h: `${stem}.h`,
    asm: `${stem}.asm`,
    readme: "README.md",
    inventory: INVENTORY_FILE,
  } as const;
  const files: Partial<Record<keyof KunaExportFiles, KunaExportFile>> = {};
  for (const [role, name] of Object.entries(names) as [
    keyof KunaExportFiles,
    string,
  ][]) {
    const path = join(request.output, name);
    const status = await lstat(path).catch((cause: unknown) => {
      if (isMissing(cause)) return undefined;
      throw cause;
    });
    if (status === undefined || !status.isFile())
      return unusable(`Kuna's export has no regular ${name}.`);
    files[role] = { path: name, ...(await hashStableFile(path, signal)) };
  }
  const complete = files as KunaExportFiles;
  const parsed = await readKunaExport(
    request.output,
    complete,
    summary,
    signal,
  );
  if (!parsed.ok) return unusable(parsed.error);
  const identity = await verifyKunaExecutable(installation, signal);
  if (!identity.ok) return { kind: "done", result: identity };
  return {
    kind: "done",
    result: ok({ files: complete, summary, ...parsed.value }),
  };
};

/** Parse an export's function blocks and inventory from its own files. */
export const readKunaExport = async (
  directory: string,
  files: KunaExportFiles,
  summary: KunaExportSummary,
  signal?: AbortSignal,
): Promise<
  Result<
    {
      readonly functions: readonly KunaProjectFunction[];
      readonly inventory: readonly KunaInventoryFunction[];
    },
    string
  >
> => {
  const functions = await scanKunaProjectSource(
    createReadStream(
      join(directory, files.c.path),
      signal === undefined ? {} : { signal },
    ),
    summary,
  );
  if (!functions.ok) return functions;
  const inventory = parseKunaInventory(
    await readFile(join(directory, files.inventory.path), {
      encoding: "utf8",
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  if (!inventory.ok) return inventory;
  return ok({ functions: functions.value, inventory: inventory.value });
};

const runKuna = async (
  request: KunaExportRequest,
  arguments_: readonly string[],
  limits: { readonly deadline: number; readonly diagnosticBytes: number },
): Promise<
  | { readonly ok: true; readonly snapshot: ProviderProcessSnapshot }
  | { readonly ok: false; readonly outcome: KunaExportOutcome }
> => {
  const { installation, signal } = request;
  try {
    const identity = await verifyKunaExecutable(installation, signal);
    if (!identity.ok)
      return { ok: false, outcome: { kind: "done", result: identity } };
    const snapshot = await runOwnedCommand(
      {
        command: installation.executable,
        arguments: arguments_,
        runId: `rea-kuna-${randomUUID()}`,
        // A script's process reports its interpreter, not the configured path.
        ...(installation.script ? { expectedCommand: null } : {}),
        cwd: request.workspace,
        hostEnvironment: kunaChildEnvironment(installation.configuration),
        env: { TMPDIR: request.workspace },
      },
      {
        timeoutMs: Math.max(1, limits.deadline - Date.now()),
        diagnosticBytes: limits.diagnosticBytes,
      },
      {
        signal,
        ...(request.launcher === undefined
          ? {}
          : { launcher: request.launcher }),
      },
    );
    return { ok: true, snapshot };
  } catch (cause: unknown) {
    return {
      ok: false,
      outcome: commandFailure(cause, request, arguments_[0] ?? "", limits),
    };
  }
};

/** Copy the target into the workspace and return the SHA-256 of exactly the bytes copied. */
const copyAndHash = async (
  source: string,
  destination: string,
  signal: AbortSignal,
): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(source),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  return hash.digest("hex");
};

/** Map an owned-command failure to its typed error, keeping unproven cleanup owned. */
const commandFailure = (
  cause: unknown,
  request: KunaExportRequest,
  subcommand: string,
  limits: { readonly diagnosticBytes: number },
): KunaExportOutcome => {
  const { installation, signal } = request;
  if (!(cause instanceof OwnedCommandFailure))
    return {
      kind: "done",
      result: err(
        signal.aborted
          ? new AnalysisCancelledError(KUNA_EXPORT_OPERATION, { cause })
          : new ProviderAdapterError(KUNA_PROVIDER_ID, KUNA_EXPORT_OPERATION, {
              cause,
              userMessage: `Cannot run ${installation.executable}: ${message(cause)}`,
            }),
      ),
    };
  const snapshot = cause.snapshot;
  const capturedOutput =
    snapshot === null
      ? undefined
      : {
          // An inventory is evidence-sized, not diagnostic-sized; keep only its tail.
          stdout: snapshot.stdout.text.slice(-4096),
          stderr: snapshot.stderr.text,
          truncated:
            snapshot.diagnosticTruncated === true ||
            snapshot.outputIncomplete === true ||
            snapshot.stdout.text.length > 4096,
          exit_code: snapshot.exitCode ?? null,
          signal: snapshot.signal ?? null,
        };
  const details = {
    cause,
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
  };
  if (cause.cleanupFailure !== null)
    return {
      kind: "retained",
      error: new ProviderCleanupError(
        KUNA_PROVIDER_ID,
        [...cause.resources, request.workspace],
        { reason: cause.cleanupFailure },
        { operation: KUNA_EXPORT_OPERATION, cause },
      ),
    };
  if (cause.reason === "cancelled")
    return {
      kind: "done",
      result: err(new AnalysisCancelledError(KUNA_EXPORT_OPERATION, details)),
    };
  if (cause.reason === "timeout")
    return {
      kind: "done",
      result: err(
        new AnalysisTimeoutError(
          KUNA_EXPORT_OPERATION,
          installation.configuration.projectTimeoutMs,
          details,
        ),
      ),
    };
  if (cause.reason === "output-limit")
    return {
      kind: "done",
      result: err(
        new AnalysisResourceConstraintError(
          KUNA_EXPORT_OPERATION,
          "capacity",
          `kuna ${subcommand} wrote more than ${String(limits.diagnosticBytes)} bytes of output; the export was not retained.`,
          { output_limit_bytes: limits.diagnosticBytes },
          details,
        ),
      ),
    };
  const exitCode = capturedOutput?.exit_code;
  return {
    kind: "done",
    result: err(
      new ProviderAdapterError(KUNA_PROVIDER_ID, KUNA_EXPORT_OPERATION, {
        ...details,
        userMessage: `kuna ${subcommand} failed${exitCode === undefined || exitCode === null ? "" : ` with exit code ${String(exitCode)}`}: ${capturedOutput?.stderr.trim().split("\n").at(-1) ?? cause.message}`,
      }),
    ),
  };
};
