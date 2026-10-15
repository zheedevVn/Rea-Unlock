import { extractApiRoutes } from "./apiRoutes.js";
import { recoverCss } from "./cssRecovery.js";
import { detectFrameworks } from "./frameworkDetection.js";
import { parsePythonBytecode } from "./pythonBytecode.js";
import {
  webStackKindForPath,
  type WebStackFileReport,
  type WebStackFinding,
} from "./webStackReport.js";

const MAX_TEXT_BYTES = 5_000_000;
const MAX_FINDINGS = 500;

/** Analyze one web artifact's bytes. Text is decoded as UTF-8; binary kinds use raw bytes. */
export const analyzeWebStackFile = (
  path: string,
  content: Buffer,
): WebStackFileReport => {
  const kind = webStackKindForPath(path);
  const findings: WebStackFinding[] = [];
  const limitations: string[] = [];
  const push = (finding: WebStackFinding): void => {
    if (findings.length < MAX_FINDINGS) findings.push(finding);
  };

  if (kind === "python-bytecode") {
    const parsed = parsePythonBytecode(content);
    push({
      category: "python-bytecode",
      title: `Python bytecode (magic ${parsed.magic})`,
      detail:
        parsed.version === null
          ? "Unknown CPython version."
          : `CPython ${parsed.version}. Top-level function: ${parsed.topLevel?.name ?? "unknown"}. References: ${parsed.topLevel?.names.slice(0, 20).join(", ") || "none"}.`,
      file: path,
    });
    if (parsed.topLevel !== null) {
      const walk = (code: typeof parsed.topLevel, depth: number): void => {
        if (depth > 8) return;
        for (const nested of code.nestedCodeObjects) {
          push({
            category: "python-bytecode",
            title: `Function ${nested.name}`,
            detail: `Defined in ${nested.filename} at line ${nested.firstLine} with ${nested.argCount} args. References: ${nested.names.slice(0, 10).join(", ") || "none"}.`,
            file: path,
            line: nested.firstLine > 0 ? nested.firstLine : undefined,
          });
          walk(nested, depth + 1);
        }
      };
      walk(parsed.topLevel, 0);
      const strings = collectStrings(parsed.topLevel);
      if (strings.length > 0)
        push({
          category: "python-bytecode",
          title: "String constants",
          detail: strings.slice(0, 20).join(", "),
          file: path,
        });
    }
    for (const limitation of parsed.limitations) limitations.push(limitation);
    return {
      path,
      kind,
      findings,
      coverage: parsed.topLevel === null ? "partial" : "complete-within-input",
      limitations,
    };
  }

  if (kind === "source-map") {
    push({
      category: "source-map",
      title: "Source map present",
      detail:
        "This .map file holds original sources. Use the existing source-map tooling (recover_javascript_sources) to restore them.",
      file: path,
    });
    return {
      path,
      kind,
      findings,
      coverage: "complete-within-input",
      limitations,
    };
  }

  if (content.length > MAX_TEXT_BYTES) {
    limitations.push(
      `File exceeds the ${MAX_TEXT_BYTES}-byte text budget; skipped.`,
    );
    return { path, kind, findings, coverage: "unknown", limitations };
  }
  const text = content.toString("utf8");

  if (kind === "css") {
    const recovered = recoverCss(text);
    push({
      category: "css",
      title: `CSS: ${recovered.ruleCount} rules, ${recovered.selectors.length} selectors`,
      detail: `At-rules: ${recovered.atRules.join(", ") || "none"}. Custom properties: ${recovered.customProperties.join(", ") || "none"}.`,
      file: path,
    });
    if (recovered.truncated)
      limitations.push("CSS input was truncated at the size budget.");
    return {
      path,
      kind,
      findings,
      coverage: "complete-within-input",
      limitations,
    };
  }

  // Source-like kinds: routes + frameworks.
  for (const route of extractApiRoutes(path, text))
    push({
      category: "api-route",
      title: `${route.method} ${route.path}`,
      detail: `Framework: ${route.framework}.`,
      file: path,
      line: route.line,
    });
  for (const framework of detectFrameworks(text))
    push({
      category: "framework",
      title: `${framework.name} (${framework.kind}, ${framework.confidence} confidence)`,
      detail: `Matched marker: ${framework.evidence}`,
      file: path,
    });
  return {
    path,
    kind,
    findings,
    coverage: "complete-within-input",
    limitations,
  };
};

const collectStrings = (code: {
  constStrings: readonly string[];
  nestedCodeObjects: readonly unknown[];
}): string[] => {
  const out: string[] = [...code.constStrings];
  for (const nested of code.nestedCodeObjects as {
    constStrings: readonly string[];
    nestedCodeObjects: readonly unknown[];
  }[])
    out.push(...collectStrings(nested));
  return out;
};
