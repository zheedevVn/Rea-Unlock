import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

import { InvestigationRecords } from "../application/investigation/InvestigationRecords.js";
import {
  EvidenceMcpServer,
  forgetPendingMcpRequest,
} from "./EvidenceMcpServer.js";
import { ToolResultDelivery } from "./toolResult.js";

const firstText = (result: {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
}): string | undefined => {
  for (const item of result.content) {
    if (item.type === "text") return item.text;
  }
  return undefined;
};

describe("MCP request bookkeeping", () => {
  it("releases list, tool, and completion state when cancellation arrives", () => {
    const completion = new AbortController();
    const pendingTools = new Map([[7, "inspect_artifact"]]);
    const pendingToolLists = new Set([7]);
    const pendingCompletions = new Map([[7, completion]]);

    forgetPendingMcpRequest(
      pendingTools,
      pendingToolLists,
      pendingCompletions,
      7,
    );

    expect(pendingTools.has(7)).toBe(false);
    expect(pendingToolLists.has(7)).toBe(false);
    expect(completion.signal.aborted).toBe(true);
    expect(pendingCompletions.has(7)).toBe(false);
  });
});

describe("SDK validation error delivery", () => {
  it("bounds oversized errors, retains their source, and preserves fitting and valid calls", async () => {
    const delivery = new ToolResultDelivery(4096);
    const records = new InvestigationRecords();
    const server = new EvidenceMcpServer(
      { name: "sdk-validation-budget-test", version: "1" },
      { capabilities: {} },
      (evidence) => records.recordEvidence(evidence),
      delivery,
    );
    server.registerTool(
      "procedure_pseudo_code",
      { inputSchema: z.strictObject({ required: z.string() }) },
      async () => ({ content: [{ type: "text", text: "valid call" }] }),
    );
    const client = new Client({
      name: "sdk-validation-budget-client",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const oversizedKey = `unexpected_${"x".repeat(6000)}`;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const oversized = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { required: "present", [oversizedKey]: true },
      });
      expect(oversized.isError).toBe(true);
      expect(oversized.structuredContent).toBeUndefined();
      expect(oversized._meta).toEqual({
        provenance: { untrusted_content: true, source: "analysis_target" },
      });
      expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(4096);
      const oversizedError = z
        .object({
          error: z.object({
            code: z.string(),
            details: z.object({
              reported_limits: z.record(z.string(), z.unknown()),
            }),
          }),
        })
        .parse(JSON.parse(firstText(oversized) ?? "null"));
      expect(oversizedError.error.code).toBe("resource_constraint");
      const reportedLimits = oversizedError.error.details.reported_limits;
      expect(reportedLimits).toMatchObject({
        evidence_reference: {
          kind: "retained-evidence",
          evidence_id: expect.any(String),
        },
        diagnostic_truncated: true,
      });
      expect(reportedLimits).not.toHaveProperty("retention");
      const bundle = records.exportEvidenceBundle();
      expect(bundle.records).toHaveLength(1);
      expect(bundle.records[0]?.operation).toBe("mcp_tool_error");
      expect(bundle.records[0]?.raw_result).toMatchObject({
        isError: true,
        content: [
          { type: "text", text: expect.stringContaining(oversizedKey) },
        ],
      });
      const evidenceReference = z
        .object({ evidence_id: z.string() })
        .parse(reportedLimits.evidence_reference);
      expect(bundle.records[0]?.evidence_id).toBe(
        evidenceReference.evidence_id,
      );

      const fitting = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { unexpected: true },
      });
      expect(fitting.isError).toBe(true);
      expect(firstText(fitting)).toContain("Input validation error");

      const quotedKey = '"\\'.repeat(350);
      const quoted = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { required: "present", [quotedKey]: true },
      });
      expect(quoted.isError).toBe(true);
      expect(firstText(quoted)).toContain("Input validation error");
      expect(Buffer.byteLength(JSON.stringify(quoted))).toBeLessThan(4096);
      expect(records.exportEvidenceBundle().records).toHaveLength(1);

      const valid = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { required: "present" },
      });
      expect(valid.content).toContainEqual({
        type: "text",
        text: "valid call",
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
