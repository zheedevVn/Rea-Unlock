import { describe, expect, it } from "vitest";
import { readNativeCallRoutes } from "./NativeCallRoutes.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import { ghidraReferenceEdge } from "../../domain/ghidraValues.fixture.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { err, ok } from "../../domain/result.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };
describe("untyped native call route fallback", () => {
  it.each([{ callees: [] }, { callees: ["0x2000"] }])(
    "preserves targetless calls and their provider when fallback callees are $callees",
    async ({ callees }) => {
      const calls: string[] = [];
      const referenceProvider = { ...provider, id: "hopper", name: "Hopper" };
      const fallbackProvider = { ...provider, id: "fallback" };
      const signal = new AbortController().signal;
      const unknown = { address: "0x1008", reason: "No static target" };
      const result = await readNativeCallRoutes(
        {
          execute: async (operation, parameters, options) => {
            calls.push(operation);
            expect(parameters.procedure).toBe("0x1000");
            expect(options).toEqual({ signal, selectorOrigin: "provider" });
            return ok(
              createAnalysisExecution(
                operation === "procedure_references"
                  ? {
                      reference_kinds_available: false,
                      references: [],
                      unresolved_calls: [unknown],
                    }
                  : callees,
                operation === "procedure_references"
                  ? referenceProvider
                  : fallbackProvider,
                {
                  limitations:
                    operation === "procedure_references"
                      ? ["Reference-kind metadata is incomplete."]
                      : ["Callee enumeration is limited to named functions."],
                },
              ),
            );
          },
        },
        "0x1000",
        signal,
        "provider",
      );
      expect(calls).toEqual(["procedure_references", "procedure_callees"]);
      expect(result).toEqual({
        ok: true,
        value: {
          provider: fallbackProvider,
          routes: callees.map((address) => ({
            address,
            site: "0x1000",
            relation: "provider_call",
            resolution: "inferred",
          })),
          unknowns: [{ ...unknown, provider: referenceProvider }],
          limitations: [
            {
              provider: referenceProvider,
              operation: "procedure_references",
              limitation: "Reference-kind metadata is incomplete.",
            },
            {
              provider: fallbackProvider,
              operation: "procedure_callees",
              limitation: "Callee enumeration is limited to named functions.",
            },
          ],
        },
      });
    },
  );
});

describe("typed native call routes", () => {
  it("preserves computed targets, ambiguity and targetless call sites", async () => {
    const reference = jsonValueSchema.parse(ghidraReferenceEdge());
    if (
      reference === null ||
      typeof reference !== "object" ||
      Array.isArray(reference)
    )
      throw new TypeError("Invalid reference fixture");
    const result = await readNativeCallRoutes(
      {
        execute: async () =>
          ok(
            createAnalysisExecution(
              {
                reference_kinds_available: true,
                references: ["0x2000", "0x3000"].map((address) => ({
                  ...reference,
                  source_address: "0x1004",
                  target_address: address,
                  target_procedure: { address },
                  kind: {
                    available: true,
                    provenance: "fixture-reference",
                    type: "COMPUTED_CALL",
                    flow: true,
                    call: true,
                    jump: false,
                    data: false,
                    read: false,
                    write: false,
                    indirect: true,
                    computed: true,
                    external: false,
                    conditional: false,
                    terminal: false,
                    primary: true,
                    operand_index: 0,
                  },
                })),
                unresolved_calls: [
                  { address: "0x1008", reason: "No static target" },
                ],
              },
              provider,
              { limitations: ["SEH handler targets may be outside the body."] },
            ),
          ),
      },
      "0x1000",
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        routes: [
          {
            address: "0x2000",
            relation: "indirect_call",
            resolution: "ambiguous",
          },
          {
            address: "0x3000",
            relation: "indirect_call",
            resolution: "ambiguous",
          },
        ],
        unknowns: [{ address: "0x1008" }],
        limitations: [
          {
            provider,
            operation: "procedure_references",
            limitation: "SEH handler targets may be outside the body.",
          },
        ],
      },
    });
  });
  it("does not fall back on cancellation or invalid typed output", async () => {
    let calls = 0;
    const cancelled = await readNativeCallRoutes(
      {
        execute: async () => {
          calls++;
          return err(new AnalysisCancelledError("procedure_references"));
        },
      },
      "0x1000",
    );
    expect(cancelled).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(calls).toBe(1);
    const malformed = await readNativeCallRoutes(
      {
        execute: async () =>
          ok(
            createAnalysisExecution({}, provider, {
              limitations: ["Malformed output still has source caveats."],
            }),
          ),
      },
      "0x1000",
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
      limitations: [
        {
          provider,
          operation: "procedure_references",
          limitation: "Malformed output still has source caveats.",
        },
      ],
    });
  });
  it("rejects omitted unresolved-call observations instead of claiming none", async () => {
    let calls = 0;
    const result = await readNativeCallRoutes(
      {
        execute: async () => {
          calls++;
          return ok(
            createAnalysisExecution(
              {
                reference_kinds_available: false,
                references: [],
              },
              provider,
            ),
          );
        },
      },
      "0x1000",
    );

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
    expect(calls).toBe(1);
  });
});
