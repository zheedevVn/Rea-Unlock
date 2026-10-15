import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { ANALYZE_WEB_STACK_CONTRACT } from "../../contracts/webstack/webStackContracts.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisCancelledError,
} from "../../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import { analyzeWebStackFile } from "../../domain/webstack/webStackAnalyzer.js";
import {
  webStackReportSchema,
  webStackKindForPath,
  type WebStackFileReport,
  type WebStackReport,
} from "../../domain/webstack/webStackReport.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";

const OPERATION = ANALYZE_WEB_STACK_CONTRACT.name;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 5_000_000;
const MAX_DEPTH = 6;
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
  ".next",
  ".nuxt",
  "vendor",
]);

const PROVIDER = {
  id: "rea-web-stack",
  name: "REA web-stack analyzer",
  version: null,
} as const;

/** Application service for the analyze_web_stack operation. */
export class WebStackAnalysisService {
  /** Analyze one local file or directory without target execution. */
  async execute(
    operation: string,
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (operation !== OPERATION)
      return err(new AnalysisInputError(OPERATION, undefined, []));
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const input = ANALYZE_WEB_STACK_CONTRACT.inputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    const { path } = input.data;
    if (!isAbsolute(path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    let targetStat: Stats;
    try {
      targetStat = await stat(path);
    } catch {
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Path does not exist: ${path}`,
          },
        ]),
      );
    }
    const files: WebStackFileReport[] = [];
    const limitations: string[] = [];
    const digests: string[] = [];
    if (targetStat.isFile()) {
      const content = await readFile(path);
      if (content.length > MAX_FILE_BYTES) {
        limitations.push(
          `File exceeds the ${MAX_FILE_BYTES}-byte budget; skipped.`,
        );
      } else {
        files.push(analyzeWebStackFile(path, content));
        digests.push(createHash("sha256").update(content).digest("hex"));
      }
    } else if (targetStat.isDirectory()) {
      const collected = await collectFiles(path, 0, limitations);
      for (const file of collected.slice(0, MAX_FILES)) {
        if (options?.signal?.aborted)
          return err(new AnalysisCancelledError(OPERATION));
        try {
          const content = await readFile(file);
          if (content.length > MAX_FILE_BYTES) {
            limitations.push(`Skipped oversized file: ${relative(path, file)}`);
            continue;
          }
          files.push(analyzeWebStackFile(file, content));
          digests.push(createHash("sha256").update(content).digest("hex"));
        } catch {
          limitations.push(`Could not read file: ${relative(path, file)}`);
        }
      }
      if (collected.length > MAX_FILES)
        limitations.push(
          `Directory walk capped at ${MAX_FILES} files; ${collected.length - MAX_FILES} more skipped.`,
        );
    } else {
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Path must be a file or a directory.",
          },
        ]),
      );
    }
    const report: WebStackReport = buildReport(path, files, limitations);
    const parsed = webStackReportSchema.safeParse(report);
    if (!parsed.success)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Generated report failed validation.",
        ),
      );
    const subjectDigest = createHash("sha256")
      .update([...digests].sort().join("\n"))
      .digest("hex");
    const evidence = createEvidence(
      {
        path,
        sha256: subjectDigest,
        format: targetStat.isDirectory() ? "directory" : "file",
      },
      PROVIDER,
      {
        operation: OPERATION,
        parameters: { path },
        // JSON round-trip drops optional undefined fields so the report
        // satisfies the JsonValue result shape.
        result: JSON.parse(JSON.stringify(parsed.data)) as JsonValue,
        confidence: "derived",
        limitations: report.limitations,
      },
    );
    return ok(evidence);
  }
}

const buildReport = (
  path: string,
  files: WebStackFileReport[],
  limitations: string[],
): WebStackReport => {
  const routes: WebStackReport["routes"] = [];
  const frameworkMap = new Map<string, WebStackReport["frameworks"][number]>();
  const confidenceRank = { high: 3, medium: 2, low: 1 } as const;
  for (const file of files) {
    for (const finding of file.findings) {
      if (finding.category === "api-route") {
        const [method, ...rest] = finding.title.split(" ");
        routes.push({
          method: method ?? "ANY",
          path: rest.join(" "),
          framework: finding.detail
            .replace(/^Framework: /, "")
            .replace(/\.$/, ""),
          file: finding.file,
          line: finding.line ?? 1,
        });
      }
      if (finding.category === "framework") {
        const name = finding.title.split(" (")[0] ?? finding.title;
        const confidence = (finding.title.match(
          /\((frontend|backend), (high|medium|low) confidence\)/,
        )?.[2] ?? "low") as "high" | "medium" | "low";
        const kind = (finding.title.match(/\((frontend|backend),/)?.[1] ??
          "backend") as "frontend" | "backend";
        const existing = frameworkMap.get(name);
        if (
          existing === undefined ||
          confidenceRank[confidence] > confidenceRank[existing.confidence]
        )
          frameworkMap.set(name, {
            name,
            kind,
            confidence,
            evidence: finding.detail.replace(/^Matched marker: /, ""),
          });
      }
    }
    limitations.push(...file.limitations);
  }
  return {
    path,
    files,
    routes,
    frameworks: [...frameworkMap.values()].sort((a, b) =>
      compareUnicodeCodePoints(a.name, b.name),
    ),
    limitations: [...new Set(limitations)],
  };
};

const collectFiles = async (
  dir: string,
  depth: number,
  limitations: string[],
): Promise<string[]> => {
  if (depth > MAX_DEPTH) {
    limitations.push(`Directory depth capped at ${MAX_DEPTH}: ${dir}`);
    return [];
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    limitations.push(`Could not list directory: ${dir}`);
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      out.push(
        ...(await collectFiles(join(dir, entry.name), depth + 1, limitations)),
      );
    } else if (entry.isFile()) {
      const filePath = join(dir, entry.name);
      if (webStackKindForPath(filePath) !== "unknown") out.push(filePath);
    }
  }
  return out;
};
