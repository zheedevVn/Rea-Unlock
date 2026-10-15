import { WebStackAnalysisService } from "../application/webstack/WebStackAnalysisService.js";
import { ANALYZE_WEB_STACK_CONTRACT } from "../contracts/webstack/webStackContracts.js";

/**
 * Internal static descriptor for the web-stack analysis operation.
 * CLI/MCP share this binding; construction performs no acquisition or target I/O.
 */
export const webStackModule = {
  contract: ANALYZE_WEB_STACK_CONTRACT,
  create(injected?: WebStackAnalysisService): WebStackAnalysisService {
    return injected ?? new WebStackAnalysisService();
  },
} as const;
