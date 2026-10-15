import { isAbsolute } from "node:path";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ElectronFusePort } from "./ElectronFusePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { BINARY_ARCHITECTURES } from "../../domain/binaryTargetTypes.js";
import {
  electronFuseReportSchema,
  inspectElectronFusesInputSchema,
} from "../../domain/electron/electronFuses.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "inspect_electron_fuses";

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class ElectronFuseService {
  constructor(readonly provider: ElectronFusePort) {}

  /** Read fuse wires for one explicitly selected path without launching it. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const input = inspectElectronFusesInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const inspected = await this.provider.inspect(input.data, options);
    if (!inspected.ok) return inspected;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const report = electronFuseReportSchema.safeParse(inspected.value);
    if (
      !report.success ||
      report.data.artifact.selected_path !== input.data.path
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Electron fuse reader returned a malformed report or changed the selected artifact identity.",
        ),
      );
    const value = report.data;
    const architecture = subjectArchitecture(value);
    return ok(
      createEvidence(
        {
          path: value.artifact.resolved_path,
          sha256: value.artifact.sha256,
          format: value.artifact.format,
          ...(architecture === undefined ? {} : { architecture }),
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.data,
          result: value,
          confidence: "observed",
          limitations: value.limitations,
          locations: locationsFor(value),
        },
      ),
    );
  }
}

const subjectArchitecture = (
  report: ReturnType<typeof electronFuseReportSchema.parse>,
) => {
  if (report.artifact.format === "mach-o-universal") return undefined;
  if (report.slices.length !== 1) return undefined;
  const name = report.slices[0]?.architecture;
  return BINARY_ARCHITECTURES.find((supported) => supported === name);
};

const locationsFor = (
  report: ReturnType<typeof electronFuseReportSchema.parse>,
) => [
  { kind: "artifact-path" as const, path: report.artifact.selected_path },
  ...(report.artifact.resolved_path === report.artifact.selected_path
    ? []
    : [
        {
          kind: "artifact-path" as const,
          path: report.artifact.resolved_path,
        },
      ]),
  ...report.slices.flatMap((slice) =>
    slice.sentinels.map((sentinel) => ({
      kind: "file-offset" as const,
      offset: sentinel.sentinel_offset,
    })),
  ),
];
