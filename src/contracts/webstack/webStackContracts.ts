import {
  analyzeWebStackInputSchema,
  webStackReportSchema,
} from "../../domain/webstack/webStackReport.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/**
 * Analyze one local web artifact (file or directory) without target
 * execution: Python .pyc inventory, API route extraction, CSS recovery, and
 * framework detection for backend and frontend code.
 */
export const ANALYZE_WEB_STACK_CONTRACT = {
  name: "analyze_web_stack",
  ...toolContractMetadata("analyze_web_stack"),
  kind: "native-provider",
  description:
    "Read one caller-selected local web artifact (a file or a directory) and report backend and frontend reverse-engineering findings: Python .pyc code-object inventory, API routes from Express/FastAPI/Flask/Django/Laravel/Go/Rails/Next.js sources, minified CSS recovery, and framework detection. Reads bytes only; never evaluates, fetches, or claims original sources. For JavaScript bundles with source maps, use recover_javascript_sources.",
  inputSchema: analyzeWebStackInputSchema,
  outputSchema: evidenceResultOf(webStackReportSchema),
  examples: [
    {
      title: "Analyze a backend source tree",
      input: { path: "/artifacts/api-server" },
    },
    {
      title: "Analyze one Python bytecode file",
      input: { path: "/artifacts/module.pyc" },
    },
  ],
} as const satisfies ToolContract;

/** Keep the public catalog in its existing order, using its named contract. */
export const WEB_STACK_TOOL_CONTRACTS = [ANALYZE_WEB_STACK_CONTRACT] as const;
