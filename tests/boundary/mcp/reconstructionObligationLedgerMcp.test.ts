import { ok as resultOk } from "../../../src/domain/result.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

describe("reconstruction obligation ledger MCP parity", () => {
  it("returns canonical bundle failures as caller input errors", async () => {
    const records = ["first", "second"].map((label) =>
      createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        {
          operation: "observe",
          parameters: { label },
          result: { label },
        },
      ),
    );
    const canonical = createEvidenceBundle(records);
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "obligation-ledger-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const request = (evidenceBundle: unknown) =>
        client.callTool({
          name: "build_reconstruction_obligation_ledger",
          arguments: {
            evidence_bundle: evidenceBundle,
            reviewed_obligations: [],
            manifest: { bindings: [], contradictions: [] },
          },
        });
      const valid = await request(canonical);
      expect(valid.isError).not.toBe(true);
      expect(valid.structuredContent).toMatchObject({
        normalized_result: { status: "unknown", summary: { total: 0 } },
      });
      const result = await request({
        ...canonical,
        records: [...canonical.records].reverse(),
      });
      expect(result.isError).toBe(true);
      expect(parseMcpToolError(result)).toMatchObject({
        error: {
          code: "invalid_request",
          category: "invalid_input",
          details: {
            operation: "build_reconstruction_obligation_ledger",
            issues: [
              expect.objectContaining({
                message: expect.stringContaining(
                  "Evidence bundle manifests are not canonical",
                ),
              }),
            ],
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });

  it("returns the complete Evidence-backed ledger inline", async () => {
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "obligation-ledger-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "build_reconstruction_obligation_ledger",
        arguments: {
          evidence_bundle: createEvidenceBundle([]),
          reviewed_obligations: [],
          manifest: {
            bindings: [],
            contradictions: [],
          },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
        normalized_result: {
          schema: "ReconstructionObligationLedger",
          status: "unknown",
          summary: { total: 0 },
        },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});
