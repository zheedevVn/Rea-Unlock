import { AsyncLocalStorage } from "node:async_hooks";

import {
  McpServer,
  isCallToolResult,
  isJSONRPCRequest,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  type Implementation,
  type Icon,
  type JSONRPCMessage,
  type McpServerOptions,
  type RegisteredTool,
  type RequestId,
  type ScopeChallengeHandler,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";

import { analysisErrorProjectionSchema } from "../contracts/errorSchemas.js";
import {
  presentAdvertisedInputSchema,
  type CompactInputSchemaPresentation,
} from "../contracts/compactInputSchema.js";
import { CATALOG_IDENTITY, createCatalogIdentity } from "../catalogIdentity.js";
import { transformAdvertisedInputJsonSchema } from "../contracts/toolSchemaMetadata.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import type { ToolResultDelivery } from "./toolResult.js";
import { toolReturnsTargetContent } from "../contracts/toolEffects.js";
import {
  carriesTargetContentMarker,
  encodeToolResult,
  measureMcpResultWithinBudget,
  TARGET_CONTENT_RESULT_META,
} from "./toolResultEncoding.js";

export type { CompactInputSchemaPresentation } from "../contracts/compactInputSchema.js";

const currentRequestSignal = new AsyncLocalStorage<AbortSignal>();

/** Signal for the completion request currently being dispatched by the SDK. */
export const currentMcpRequestSignal = (): AbortSignal | undefined =>
  currentRequestSignal.getStore();

/** A Zod schema whose standard interface exposes a JSON Schema projection. */
const hasAdvertisedInputJsonSchema = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const standard = Reflect.get(value, "~standard");
  if (typeof standard !== "object" || standard === null) return false;
  const jsonSchema = Reflect.get(standard, "jsonSchema");
  return (
    typeof jsonSchema === "object" &&
    jsonSchema !== null &&
    Reflect.get(jsonSchema, "input") !== undefined
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Remove only client-facing output schemas; SDK registrations stay canonical. */
const omitOutputSchemasFromToolsList = (
  message: JSONRPCMessage,
  requestId: RequestId,
): JSONRPCMessage => {
  if (
    !isJSONRPCResultResponse(message) ||
    message.id !== requestId ||
    !isRecord(message.result) ||
    !Array.isArray(message.result.tools)
  )
    return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: message.result.tools.map((tool: unknown) => {
        if (!isRecord(tool)) return tool;
        const { outputSchema: _outputSchema, ...advertisedTool } = tool;
        return advertisedTool;
      }),
    },
  } as JSONRPCMessage;
};

/** Release every transport-owned reference for a cancelled/completed request. */
export const forgetPendingMcpRequest = (
  pendingTools: Map<RequestId, string>,
  pendingToolLists: Set<RequestId>,
  pendingCompletions: Map<RequestId, AbortController>,
  id: RequestId,
): void => {
  pendingTools.delete(id);
  pendingToolLists.delete(id);
  pendingCompletions.get(id)?.abort();
  pendingCompletions.delete(id);
};

/** Bind oversized MCP error recovery to this server's Evidence ledger. */
export class EvidenceMcpServer extends McpServer {
  readonly catalogIdentity: ReturnType<typeof createCatalogIdentity>;
  private readonly compactPresentation:
    | CompactInputSchemaPresentation
    | undefined;

  constructor(
    info: Implementation,
    options: McpServerOptions,
    private readonly recordEvidence:
      | EvidenceWriter["recordEvidence"]
      | undefined,
    readonly delivery: ToolResultDelivery,
    compactPresentation: CompactInputSchemaPresentation | undefined = undefined,
    private readonly omitOutputSchemas = false,
  ) {
    super(info, options);
    this.compactPresentation =
      compactPresentation === undefined
        ? undefined
        : { budgetBytes: compactPresentation.budgetBytes };
    this.catalogIdentity =
      this.compactPresentation === undefined && !this.omitOutputSchemas
        ? CATALOG_IDENTITY
        : createCatalogIdentity(
            this.compactPresentation,
            this.omitOutputSchemas ? "off" : "full",
          );
  }

  /**
   * Compact advertised input schemas and optionally omit output-schema
   * advertisements. Canonical parsers and contracts remain registered; the
   * output-schema-off path validates successful structured results locally.
   * The signatures mirror the SDK's registrations so call sites keep their
   * inferred handler argument types.
   */
  override registerTool<
    OutputArgs extends StandardSchemaWithJSON,
    InputArgs extends StandardSchemaWithJSON | undefined = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      icons?: Icon[];
      scopeChallenge?: ScopeChallengeHandler;
      _meta?: Record<string, unknown>;
    },
    callback: ToolCallback<InputArgs>,
  ): RegisteredTool {
    const budget = this.compactPresentation?.budgetBytes;
    const inputSchema =
      budget !== undefined &&
      config !== undefined &&
      hasAdvertisedInputJsonSchema(config.inputSchema)
        ? transformAdvertisedInputJsonSchema(
            config.inputSchema as Parameters<
              typeof transformAdvertisedInputJsonSchema
            >[0],
            (projected) =>
              presentAdvertisedInputSchema(projected, { budgetBytes: budget }),
          )
        : undefined;
    const registeredConfig =
      inputSchema === undefined ? config : { ...config, inputSchema };
    return super.registerTool(
      name,
      registeredConfig as never,
      callback as never,
    );
  }

  /** Preserve the SDK transport lifecycle while retaining oversized errors. */
  override connect(transport: Transport): Promise<void> {
    return super.connect(
      new ErrorEvidenceTransport(
        transport,
        this.recordEvidence,
        this.delivery,
        this.omitOutputSchemas,
      ),
    );
  }
}

class ErrorEvidenceTransport implements Transport {
  onclose: Transport["onclose"];
  onerror: Transport["onerror"];
  onmessage: Transport["onmessage"];
  readonly hasPerRequestStream?: boolean;
  private readonly pendingTools = new Map<RequestId, string>();
  private readonly pendingToolLists = new Set<RequestId>();
  private readonly pendingCompletions = new Map<RequestId, AbortController>();

  constructor(
    private readonly transport: Transport,
    private readonly recordEvidence:
      | EvidenceWriter["recordEvidence"]
      | undefined,
    private readonly delivery: ToolResultDelivery,
    private readonly omitOutputSchemas: boolean,
  ) {
    if (transport.hasPerRequestStream !== undefined)
      this.hasPerRequestStream = transport.hasPerRequestStream;
    transport.onmessage = (message, extra) => {
      if (
        isJSONRPCRequest(message) &&
        message.method === "tools/call" &&
        typeof message.params?.["name"] === "string"
      )
        this.pendingTools.set(message.id, message.params["name"]);
      if (isJSONRPCRequest(message) && message.method === "tools/list")
        this.pendingToolLists.add(message.id);
      if (isJSONRPCRequest(message) && message.method === "completion/complete")
        this.pendingCompletions.set(message.id, new AbortController());
      // The SDK suppresses replies after cancellation, so send() cannot release
      // this bookkeeping. Keep transport authentication outside retained data.
      if (
        isJSONRPCNotification(message) &&
        message.method === "notifications/cancelled"
      ) {
        const id = message.params?.["requestId"];
        if (typeof id === "string" || typeof id === "number")
          forgetPendingMcpRequest(
            this.pendingTools,
            this.pendingToolLists,
            this.pendingCompletions,
            id,
          );
      }
      const completion =
        isJSONRPCRequest(message) && message.method === "completion/complete"
          ? this.pendingCompletions.get(message.id)
          : undefined;
      if (completion === undefined) this.onmessage?.(message, extra);
      else
        currentRequestSignal.run(completion.signal, () =>
          this.onmessage?.(message, extra),
        );
    };
    transport.onerror = (error) => this.onerror?.(error);
    transport.onclose = () => {
      this.pendingTools.clear();
      this.pendingToolLists.clear();
      for (const completion of this.pendingCompletions.values())
        completion.abort();
      this.pendingCompletions.clear();
      this.onclose?.();
    };
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }
  set sessionId(value: string | undefined) {
    this.transport.sessionId = value;
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  async close(): Promise<void> {
    try {
      await this.transport.close();
    } finally {
      this.pendingTools.clear();
      this.pendingToolLists.clear();
      for (const completion of this.pendingCompletions.values())
        completion.abort();
      this.pendingCompletions.clear();
    }
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.transport.setSupportedProtocolVersions?.(versions);
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    const id =
      "id" in message &&
      (typeof message.id === "string" || typeof message.id === "number")
        ? message.id
        : undefined;
    const tool = id === undefined ? undefined : this.pendingTools.get(id);
    const omitToolSchemas =
      this.omitOutputSchemas &&
      id !== undefined &&
      this.pendingToolLists.has(id);
    try {
      const recovered = this.recoverError(message, tool);
      const advertised = omitToolSchemas
        ? omitOutputSchemasFromToolsList(recovered, id)
        : recovered;
      if (
        isJSONRPCResultResponse(advertised) &&
        isCallToolResult(advertised.result) &&
        advertised.result.isError === true
      ) {
        // Keep the complete typed JSON in content. Error projections are not
        // success outputSchema data; oversized recovery must consume their
        // private structured carrier before it is removed from the wire.
        const { structuredContent: _diagnostic, ...result } = advertised.result;
        // Errors the SDK builds itself (input validation, a thrown handler)
        // bypass ToolResultDelivery; mark them for target-content tools too.
        const marked =
          tool !== undefined &&
          toolReturnsTargetContent(tool) &&
          !carriesTargetContentMarker(result)
            ? {
                ...result,
                _meta: { ...result._meta, ...TARGET_CONTENT_RESULT_META },
              }
            : result;
        await this.transport.send({ ...advertised, result: marked }, options);
      } else await this.transport.send(advertised, options);
    } finally {
      if (!isJSONRPCRequest(message) && id !== undefined) {
        forgetPendingMcpRequest(
          this.pendingTools,
          this.pendingToolLists,
          this.pendingCompletions,
          id,
        );
      }
    }
  }

  private recoverError(
    message: JSONRPCMessage,
    tool: string | undefined,
  ): JSONRPCMessage {
    if (
      !isJSONRPCResultResponse(message) ||
      !isCallToolResult(message.result) ||
      message.result.isError !== true
    )
      return message;
    const budget = this.delivery.resultBudgetBytes;
    // Count the provenance marker exactly as the projected error did, and keep
    // it on the replacement: the retained original may hold target content.
    const targetContent =
      carriesTargetContentMarker(message.result) ||
      (tool !== undefined && toolReturnsTargetContent(tool));
    // SDK validation failures have no structured carrier. Size their existing
    // text-only result without serializing the complete JSON-RPC message.
    const isStructured = message.result.structuredContent !== undefined;
    const structured = isStructured
      ? jsonObjectSchema.parse(message.result.structuredContent)
      : undefined;
    const sdkResultWithMarker =
      !isStructured &&
      targetContent &&
      !carriesTargetContentMarker(message.result)
        ? {
            ...message.result,
            _meta: {
              ...message.result._meta,
              ...TARGET_CONTENT_RESULT_META,
            },
          }
        : message.result;
    const encoded =
      structured !== undefined
        ? encodeToolResult(structured, budget, "error-text", targetContent)
        : measureMcpResultWithinBudget(sdkResultWithMarker, budget);
    if (encoded.ok) return message;
    const operation = tool ?? "mcp_tool_error";
    const originalResult = jsonObjectSchema.parse(message.result);
    const sdkDiagnostic = !isStructured
      ? message.result.content.find((item) => item.type === "text")?.text
      : undefined;
    const retainedResult = structured ?? originalResult;
    const originalError = isStructured
      ? analysisErrorProjectionSchema.safeParse(structured?.["error"])
      : undefined;
    // Retain the complete original response, including SDK validation text.
    // The SDK error contains its rendered issue, not a separate argument bag;
    // transport authentication and caller arguments are never added here.
    const evidence = createEvidence(
      undefined,
      { id: "rea-mcp", name: "REA MCP delivery", version: "1" },
      {
        operation: "mcp_tool_error",
        parameters: { tool_name: operation },
        result:
          sdkDiagnostic === undefined
            ? retainedResult
            : {
                boundary: "sdk-input-validation",
                diagnostic_preview: sdkDiagnostic.slice(0, 256),
                diagnostic_truncated: sdkDiagnostic.length > 256,
              },
        rawResult: originalResult,
      },
    );
    const recorded = this.recordEvidence?.(evidence);
    const retained = recorded !== undefined && recorded.ok;
    const failure = new AnalysisResourceConstraintError(
      operation,
      "transport",
      "The tool failed, but its complete error response exceeds the MCP response budget.",
      {
        boundary: "mcp-response",
        ...(originalError?.success
          ? { original_error_code: originalError.data.code }
          : {}),
        result_budget_bytes: budget,
        response_bytes_at_least: encoded.bytesAtLeast,
        constraint: encoded.constraint,
        ...(sdkDiagnostic === undefined
          ? {}
          : {
              diagnostic_preview: sdkDiagnostic.slice(0, 256),
              diagnostic_truncated: sdkDiagnostic.length > 256,
            }),
        ...(retained
          ? {
              evidence_reference: {
                kind: "retained-evidence",
                evidence_id: evidence.evidence_id,
              },
            }
          : { retention: recorded === undefined ? "unavailable" : "failed" }),
        ...(recorded !== undefined && !recorded.ok
          ? { retention_error: projectAnalysisError(recorded.error) }
          : {}),
      },
      {
        remediationAction: retained
          ? "Export the retained original error through export_evidence_bundle to a caller-selected path. The connection remains usable."
          : "Restart REA with a larger REA_MCP_MAX_RESPONSE_BYTES and matching client receive buffer, then retry. The original error could not be retained by this server.",
      },
    );
    return {
      ...message,
      result: this.delivery.toErrorToolResult(failure, targetContent),
    };
  }
}
