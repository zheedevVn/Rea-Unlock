import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { hashStableFile } from "../filesystem/StableFileHash.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import {
  readKunaConfiguration,
  type KunaConfiguration,
  type KunaConfigurationFailure,
} from "./KunaConfiguration.js";
import {
  KUNA_COMMAND_REMEDIATION,
  KUNA_VERIFIED_VERSION,
  KUNA_VERSION_PROBE_REMEDIATION,
} from "./KunaRelease.js";

/** `kuna --version` exits before loading specs or an input; it needs no budget beyond this. */
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const VERSION_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

/** Release CI prints exactly `kuna <MAJOR.MINOR>`; source builds print the Cargo version. */
const VERSION_LINE = /^kuna (\d+\.\d+(?:\.\d+)?)\r?\n?$/u;

/** One observed Kuna executable, identified by its bytes as well as its version. */
export interface KunaInstallation {
  readonly configuration: KunaConfiguration;
  /** Canonical path of the probed executable. */
  readonly executable: string;
  readonly version: string;
  /** Whether this release is the one REA verified. */
  readonly verified: boolean;
  readonly sha256: string;
  readonly bytes: number;
  /**
   * Whether the executable is a `#!` script, such as a package-manager shim.
   * Its process then reports the interpreter as its command, so ownership
   * checks cannot match the configured path by argv prefix.
   */
  readonly script: boolean;
}

/** Why the selected Kuna installation cannot be used. */
export interface KunaReadinessFailure {
  readonly code:
    | KunaConfigurationFailure["code"]
    | "executable_missing"
    | "version_unresolved";
  readonly reason: string;
  readonly diagnostics: Readonly<Record<string, JsonValue>>;
}

/**
 * Environment for every Kuna child. Kuna unpacks its built-in SLEIGH tree into
 * the per-user cache under HOME (macOS) or XDG_CACHE_HOME (Linux), so both
 * point inside REA's own cache root instead of the user's.
 */
export const kunaChildEnvironment = (
  configuration: KunaConfiguration,
): NodeJS.ProcessEnv => {
  const home = join(configuration.cacheRoot, "home");
  return {
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    NO_COLOR: "1",
  };
};

const failure = (
  code: KunaReadinessFailure["code"],
  reason: string,
  diagnostics: Readonly<Record<string, JsonValue>>,
): Result<never, KunaReadinessFailure> => err({ code, reason, diagnostics });

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Resolve, version-probe and fingerprint the configured executable. */
export const inspectKunaInstallation = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly signal?: AbortSignal;
    /** Probe deadline; tests shorten it. */
    readonly probeTimeoutMs?: number;
  } = {},
): Promise<Result<KunaInstallation, KunaReadinessFailure>> => {
  const configuration = readKunaConfiguration(environment, options.platform);
  if (!configuration.ok)
    return failure(configuration.error.code, configuration.error.reason, {
      configured: configuration.error.code !== "not_configured",
      ...(configuration.error.setting === null
        ? {}
        : { setting: configuration.error.setting }),
    });
  const { command } = configuration.value;

  let executable: string;
  try {
    executable = await realpath(command);
    await access(executable, constants.X_OK);
    if (!(await stat(executable)).isFile())
      return failure(
        "executable_missing",
        `REA_KUNA_COMMAND is not a regular file: ${command}. ${KUNA_COMMAND_REMEDIATION}`,
        { command },
      );
  } catch (cause: unknown) {
    options.signal?.throwIfAborted();
    return failure(
      "executable_missing",
      `Cannot execute REA_KUNA_COMMAND ${command}: ${message(cause)}. ${KUNA_COMMAND_REMEDIATION}`,
      { command },
    );
  }

  const deadline = options.probeTimeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  let stdout: string;
  try {
    ({ stdout } = await execFileOutput(executable, ["--version"], {
      env: kunaChildEnvironment(configuration.value),
      timeout: deadline,
      maxBuffer: VERSION_PROBE_MAX_OUTPUT_BYTES,
      // Escalate to SIGKILL so an executable that ignores SIGTERM cannot hang doctor.
      stopSignal: "SIGTERM",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
  } catch (cause: unknown) {
    options.signal?.throwIfAborted();
    const output = execFileOutputFailure(cause);
    return failure(
      "version_unresolved",
      `${executable} --version failed: ${output?.stderr.trim() || message(cause)}. ${KUNA_VERSION_PROBE_REMEDIATION}`,
      {
        command,
        executable,
        exit_code: typeof output?.code === "number" ? output.code : null,
        signal: output?.signal ?? null,
        killed: output?.killed ?? false,
        output_truncated: output?.outputTruncated ?? false,
        deadline_ms: deadline,
      },
    );
  }
  const version = VERSION_LINE.exec(stdout)?.[1];
  if (version === undefined)
    return failure(
      "version_unresolved",
      `${executable} --version printed no recognizable Kuna version. ${KUNA_VERSION_PROBE_REMEDIATION}`,
      { command, executable, stdout: stdout.slice(0, 256) },
    );

  let fingerprint: { readonly sha256: string; readonly bytes: number };
  let script: boolean;
  try {
    fingerprint = await hashStableFile(executable, options.signal);
    script = await startsWithShebang(executable);
  } catch (cause: unknown) {
    options.signal?.throwIfAborted();
    return failure(
      "executable_missing",
      `Cannot fingerprint ${executable}: ${message(cause)}`,
      { command, executable },
    );
  }

  return ok({
    configuration: configuration.value,
    executable,
    version,
    verified: version === KUNA_VERIFIED_VERSION,
    ...fingerprint,
    script,
  });
};

const startsWithShebang = async (path: string): Promise<boolean> => {
  const handle = await open(path, "r");
  try {
    const prefix = Buffer.alloc(2);
    const { bytesRead } = await handle.read(prefix, 0, 2, 0);
    return bytesRead === 2 && prefix.toString("latin1") === "#!";
  } finally {
    await handle.close();
  }
};
