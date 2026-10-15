import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { ElectronFusePort } from "../application/electron/ElectronFusePort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  describeElectronFuseFindings,
  electronFuseReportSchema,
  type ElectronFuseReport,
  type InspectElectronFusesInput,
} from "../domain/electron/electronFuses.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import { ZodError } from "zod";
import { RegularFileChangedError } from "../filesystem/RegularFile.js";
import { NonRegularFileReadError } from "../filesystem/RegularFile.js";
import {
  ElectronFusePathFailure,
  resolveElectronFuseTarget,
} from "./ElectronFusePath.js";
import {
  electronFuseReadLimitation,
  ElectronFuseFormatFailure,
  ElectronFuseResourceFailure,
  readElectronFuseImage,
} from "./ElectronFuseReader.js";

/** Bundled fuse-wire reader. It does not flip fuses or launch the application. */
export const ELECTRON_FUSE_PROVIDER_IDENTITY = {
  id: "electron-fuses",
  name: "REA Electron fuse reader",
  version: "1",
} as const;

const OPERATION = "inspect_electron_fuses";

/** Read packaged Electron fuse wires from one selected local file or app bundle. */
export class ElectronFuseProvider implements ElectronFusePort {
  readonly identity = ELECTRON_FUSE_PROVIDER_IDENTITY;

  async inspect(
    input: InspectElectronFusesInput,
    options?: ExecutionOptions,
  ): Promise<Result<ElectronFuseReport, AnalysisError>> {
    try {
      options?.signal?.throwIfAborted();
      const located = await resolveElectronFuseTarget(
        input.path,
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      const image = await readElectronFuseImage(located.file.path, {
        selection: located.file,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      const findings = describeElectronFuseFindings(image.slices, image.format);
      const parsed = electronFuseReportSchema.safeParse({
        artifact: {
          selected_path: located.selectedPath,
          resolved_path: located.file.path,
          sha256: image.sha256,
          bytes: image.bytes,
          format: image.format,
        },
        slices: image.slices,
        runtime_implications: findings.runtime_implications,
        limitations: [...findings.limitations, electronFuseReadLimitation()],
      });
      if (!parsed.success)
        throw new AnalysisOutputError(
          OPERATION,
          "Electron fuse reader produced a report outside its schema.",
          { cause: parsed.error },
        );
      options?.signal?.throwIfAborted();
      return ok(parsed.data);
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, options?.signal));
    }
  }
}

const failureFor = (
  cause: unknown,
  path: string,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (signal?.aborted) return new AnalysisCancelledError(OPERATION);
  if (cause instanceof ElectronFusePathFailure)
    return new AnalysisInputError(OPERATION, { cause }, [
      { path: ["path"], reason: cause.reason, message: cause.message },
    ]);
  if (cause instanceof ElectronFuseResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      cause.boundary === "file-size" ? "file-size" : "capacity",
      cause.message,
      cause.boundary === "file-size"
        ? { maximum_input_bytes: 1024 * 1024 * 1024 }
        : { maximum_sentinels_per_slice: 32 },
      { cause },
    );
  if (cause instanceof ElectronFuseFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(OPERATION, path, cause.message, {
          cause,
        })
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected artifact ${path}: ${cause.message}`,
          },
        ]);
  if (cause instanceof RegularFileChangedError)
    return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
      cause,
    });
  if (cause instanceof NonRegularFileReadError)
    return new AnalysisInputError(OPERATION, { cause }, [
      {
        path: ["path"],
        reason: "invalid_format",
        message: cause.message,
      },
    ]);
  if (cause instanceof ZodError)
    return new AnalysisOutputError(
      OPERATION,
      "Electron fuse reader produced a report outside its schema.",
      { cause },
    );
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(
        String(cause.code),
      )
    )
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected artifact could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(
    ELECTRON_FUSE_PROVIDER_IDENTITY.id,
    OPERATION,
    {
      cause,
      diagnostics: {
        path,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    },
  );
};
