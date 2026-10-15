/** Minified-CSS recovery: beautify + selector/at-rule inventory. */

export interface CssRecovery {
  readonly beautified: string;
  readonly selectors: readonly string[];
  readonly atRules: readonly string[];
  readonly customProperties: readonly string[];
  readonly ruleCount: number;
  readonly truncated: boolean;
}

const MAX_INPUT = 2_000_000;
const MAX_OUTPUT = 2_000_000;
const MAX_ITEMS = 5_000;

/** Beautify CSS: one declaration per line, 2-space indent, brace-aware. */
export const beautifyCss = (css: string): string => {
  const lines: string[] = [];
  let indent = 0;
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  const flush = (): void => {
    let trimmed = current.trim();
    current = "";
    if (trimmed.length === 0) return;
    // Inside a rule, normalize the first declaration colon: `color:red` -> `color: red`.
    if (indent > 0) {
      const declaration = /^([A-Za-z-]+):(\S.*)$/.exec(trimmed);
      if (declaration !== null)
        trimmed = `${declaration[1]}: ${declaration[2]}`;
    }
    lines.push(`${"  ".repeat(Math.max(indent, 0))}${trimmed}`);
  };
  for (const char of css) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "{") {
      current += " {";
      flush();
      indent += 1;
      continue;
    }
    if (char === "}") {
      flush();
      indent = Math.max(indent - 1, 0);
      lines.push(`${"  ".repeat(indent)}}`);
      continue;
    }
    if (char === ";") {
      current += ";";
      flush();
      continue;
    }
    if (char === "\n" || char === "\r" || char === "\t") {
      current += " ";
      continue;
    }
    current += char;
  }
  flush();
  return lines.join("\n").slice(0, MAX_OUTPUT);
};

/** Recover structure from CSS text (minified or not). */
export const recoverCss = (css: string): CssRecovery => {
  const input = css.slice(0, MAX_INPUT);
  const truncated = css.length > MAX_INPUT;
  const selectors: string[] = [];
  const atRules: string[] = [];
  const customProperties: string[] = [];
  const seenSelectors = new Set<string>();
  const seenAtRules = new Set<string>();
  const seenCustom = new Set<string>();
  let ruleCount = 0;
  // Strip comments and quoted strings for inventory (keep them in the beautified output).
  const withoutComments = input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  // Selector text precedes each '{' outside strings.
  const selectorPattern = /([^{};"']+)\{/g;
  for (;;) {
    const match = selectorPattern.exec(withoutComments);
    if (match === null) break;
    const raw = (match[1] ?? "").trim().replace(/\s+/g, " ");
    if (raw.length === 0) continue;
    ruleCount += 1;
    if (raw.startsWith("@")) {
      const name = raw.split(/[\s(]/u)[0] ?? raw;
      if (name !== "" && !seenAtRules.has(name) && atRules.length < MAX_ITEMS) {
        seenAtRules.add(name);
        atRules.push(name);
      }
      continue;
    }
    for (const part of raw.split(",")) {
      const selector = part.trim();
      if (
        selector !== "" &&
        !seenSelectors.has(selector) &&
        selectors.length < MAX_ITEMS
      ) {
        seenSelectors.add(selector);
        selectors.push(selector);
      }
    }
  }
  const customPattern = /(--[A-Za-z0-9_-]+)\s*:/g;
  for (;;) {
    const match = customPattern.exec(withoutComments);
    if (match === null) break;
    const name = match[1] ?? "";
    if (
      name !== "" &&
      !seenCustom.has(name) &&
      customProperties.length < MAX_ITEMS
    ) {
      seenCustom.add(name);
      customProperties.push(name);
    }
  }
  return {
    beautified: beautifyCss(input),
    selectors,
    atRules,
    customProperties,
    ruleCount,
    truncated,
  };
};
