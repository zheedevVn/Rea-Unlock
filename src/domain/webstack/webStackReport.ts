import { z } from "zod";

/** Kind of one analyzed web artifact, derived from its extension. */
export const webStackFileKindSchema = z.enum([
  "python-bytecode",
  "javascript",
  "typescript",
  "python",
  "php",
  "go",
  "ruby",
  "css",
  "html",
  "source-map",
  "unknown",
]);
export type WebStackFileKind = z.infer<typeof webStackFileKindSchema>;

/** One observation about a web artifact. */
export const webStackFindingSchema = z.strictObject({
  category: z.enum([
    "python-bytecode",
    "api-route",
    "framework",
    "css",
    "source-map",
    "limitation",
  ]),
  title: z.string().min(1),
  detail: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
});
export type WebStackFinding = z.infer<typeof webStackFindingSchema>;

/** Per-file analysis result. */
export const webStackFileReportSchema = z.strictObject({
  path: z.string().min(1),
  kind: webStackFileKindSchema,
  findings: z.array(webStackFindingSchema),
  coverage: z.enum(["complete-within-input", "partial", "unknown"]),
  limitations: z.array(z.string()),
});
export type WebStackFileReport = z.infer<typeof webStackFileReportSchema>;

/** Whole-tool report for one input path (file or directory). */
export const webStackReportSchema = z.strictObject({
  path: z.string().min(1),
  files: z.array(webStackFileReportSchema),
  routes: z.array(
    z.strictObject({
      method: z.string().min(1),
      path: z.string().min(1),
      framework: z.string().min(1),
      file: z.string().min(1),
      line: z.number().int().positive(),
    }),
  ),
  frameworks: z.array(
    z.strictObject({
      name: z.string().min(1),
      kind: z.enum(["frontend", "backend"]),
      confidence: z.enum(["high", "medium", "low"]),
      evidence: z.string().min(1),
    }),
  ),
  limitations: z.array(z.string()),
});
export type WebStackReport = z.infer<typeof webStackReportSchema>;

/** Input for the web-stack analysis operation. */
export const analyzeWebStackInputSchema = z.strictObject({
  path: z.string().min(1).describe("Absolute local file or directory path."),
});

/** Map a file extension to its web-stack kind. */
export const webStackKindForPath = (path: string): WebStackFileKind => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pyc")) return "python-bytecode";
  if (/\.(?:cjs|mjs|jsx)$/.test(lower) || lower.endsWith(".js"))
    return "javascript";
  if (/\.(?:ts|tsx|mts|cts)$/.test(lower)) return "typescript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".css")) return "css";
  if (/\.(?:html?|htm)$/.test(lower)) return "html";
  if (lower.endsWith(".map")) return "source-map";
  return "unknown";
};
