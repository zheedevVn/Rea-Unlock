import type { Logger } from "pino";

import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { ContractToolService } from "./contractToolHandler.js";
import { createContractToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { ANALYZE_WEB_STACK_CONTRACT } from "../contracts/webstack/webStackContracts.js";

/** Bind the web-stack analysis contract to the shared validation and delivery workflow. */
export const registerWebStackTools = (
  server: EvidenceMcpServer,
  service: ContractToolService<typeof ANALYZE_WEB_STACK_CONTRACT.name>,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const handler = createContractToolHandler(
    server,
    service,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    ANALYZE_WEB_STACK_CONTRACT.name,
    toolRegistrationOptions(ANALYZE_WEB_STACK_CONTRACT),
    handler(ANALYZE_WEB_STACK_CONTRACT),
  );
};
