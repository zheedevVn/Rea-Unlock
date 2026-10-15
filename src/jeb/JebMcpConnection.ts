import {
  Client,
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  AnalysisCancelledError,
  AnalysisProtocolError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import type { JebOperation } from "../domain/jeb/jebAnalysis.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";

/** Upstream protocol names for the operations REA exposes. */
export const JEB_ENGINE_TOOLS = {
  inspect_jeb_client: "get_client_information",
  open_jeb_project: "open_project",
  list_jeb_units: "list_units",
  decompile_jeb_item: "decompile_code_item",
} as const satisfies Readonly<Record<JebOperation, string>>;
const RELEVANT_ENGINE_TOOLS = new Set<string>(Object.values(JEB_ENGINE_TOOLS));

/** Injectable MCP boundary used by the provider and conformance tests. */
export interface JebMcpConnection {
  /** Connect lazily and return advertised names used by REA. */
  connect(signal?: AbortSignal): Promise<readonly string[]>;
  /** Refresh support for REA operations from the live engine catalog. */
  listTools(signal?: AbortSignal): Promise<readonly string[]>;
  /** Invoke one JEB MCP tool and decode its single structured result. */
  call(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<JsonValue>;
  close(): Promise<void>;
}

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z
    .array(
      z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
    )
    .default([]),
});

/** Decode a JEB MCP tool result without inventing an empty observation. */
export const decodeJebToolResult = (input: unknown): JsonValue => {
  const result = toolResultSchema.parse(input);
  const blocks = result.content.flatMap((block) =>
    block.type === "text" && block.text !== undefined ? [block.text] : [],
  );
  let decoded: JsonValue;
  if (result.structuredContent !== undefined) {
    decoded = jsonValueSchema.parse(result.structuredContent);
  } else {
    if (blocks.length !== 1)
      throw new AnalysisProtocolError(
        "JEB MCP omitted a single structured or text result; unsupported content cannot establish an empty observation.",
      );
    const text = blocks[0] ?? "null";
    try {
      decoded = jsonValueSchema.parse(JSON.parse(text));
    } catch {
      decoded = text;
    }
  }
  if (result.isError === true && !isJebFailureEnvelope(decoded))
    throw new AnalysisProtocolError(
      `JEB MCP tool failed: ${blocks[0] ?? "error-marked result without a JEB failure envelope"}`,
      { cause: decoded },
    );
  return decoded;
};

const isJebFailureEnvelope = (value: JsonValue): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  value.success === false;

export interface JebMcpConnectionTimeouts {
  /** Absolute catalog connection and pagination deadline. */
  readonly discoveryTimeoutMs?: number;
  /** Absolute timeout for each upstream tools/call request. */
  readonly requestTimeoutMs?: number;
}

export type JebMcpConnectionFactory = (
  endpoint: URL,
  timeouts?: JebMcpConnectionTimeouts,
) => JebMcpConnection;

/** Serve JEB requests from a running engine client over streamable HTTP. */
export const createStreamableHttpJebMcpConnection: JebMcpConnectionFactory = (
  endpoint,
  timeouts,
) => {
  const discoveryTimeoutMs =
    timeouts?.discoveryTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
  const requestTimeoutMs =
    timeouts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
  interface ConnectionState {
    readonly client: Client;
    readonly transport: StreamableHTTPClientTransport;
    readonly signal: AbortController;
    tools: readonly string[] | undefined;
    acquisition: Promise<readonly string[]> | undefined;
    disposal: Promise<void> | undefined;
  }
  let state: ConnectionState | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;

  const waitForCaller = <Value>(
    promise: Promise<Value>,
    signal?: AbortSignal,
  ): Promise<Value> => {
    if (signal?.aborted === true)
      return Promise.reject(new AnalysisCancelledError("jeb_mcp"));
    if (signal === undefined) return promise;
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(new AnalysisCancelledError("jeb_mcp"));
      };
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (cause: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(cause);
        },
      );
    });
  };

  const dispose = async (owner: ConnectionState): Promise<void> => {
    if (owner.disposal !== undefined) return owner.disposal;
    const cleanup = (async () => {
      const settled = await Promise.allSettled([
        owner.client.close(),
        owner.transport.close(),
      ]);
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(failures, "JEB MCP connection cleanup failed");
      if (state === owner) state = undefined;
    })();
    owner.disposal = cleanup;
    try {
      await cleanup;
    } catch (cause: unknown) {
      owner.disposal = undefined;
      throw cause;
    }
  };

  const connect = async (signal?: AbortSignal): Promise<readonly string[]> => {
    if (signal?.aborted === true) throw new AnalysisCancelledError("jeb_mcp");
    if (closing !== undefined) await closing;
    if (closed) {
      if (state !== undefined) await dispose(state);
      throw new AnalysisProtocolError("JEB MCP connection is closed");
    }
    if (state?.tools !== undefined && state.disposal === undefined)
      return state.tools;
    if (state?.acquisition !== undefined)
      return waitForCaller(state.acquisition, signal);
    if (state !== undefined) {
      await dispose(state);
      if (state !== undefined || closing !== undefined) return connect(signal);
    }
    const owner: ConnectionState = {
      client: new Client({
        name: "rea-jeb",
        version: "0.0.0",
      }),
      transport: new StreamableHTTPClientTransport(endpoint, {
        requestInit: { redirect: "error" },
      }),
      signal: new AbortController(),
      tools: undefined,
      acquisition: undefined,
      disposal: undefined,
    };
    state = owner;
    const acquisition = (async () => {
      const deadline = new ProviderStartupDeadline(
        discoveryTimeoutMs,
        owner.signal.signal,
      );
      try {
        await owner.client.connect(owner.transport, {
          signal: deadline.signal,
        });
        const tools = await readToolNames(owner.client, deadline.signal);
        owner.tools = tools;
        return tools;
      } catch (cause: unknown) {
        const failure =
          deadline.interruption === "timeout"
            ? new AnalysisTimeoutError("jeb_mcp_catalog", discoveryTimeoutMs, {
                cause,
              })
            : cause;
        owner.signal.abort(failure);
        try {
          await dispose(owner);
        } catch (cleanupCause: unknown) {
          throw new AggregateError(
            [failure, cleanupCause],
            "JEB MCP connection acquisition and cleanup failed",
            { cause: failure },
          );
        }
        throw failure;
      } finally {
        deadline.dispose();
      }
    })();
    owner.acquisition = acquisition;
    void acquisition.then(
      () => {
        if (owner.acquisition === acquisition) owner.acquisition = undefined;
      },
      () => {
        if (owner.acquisition === acquisition) owner.acquisition = undefined;
      },
    );
    return waitForCaller(acquisition, signal);
  };

  return {
    connect,
    async listTools(signal) {
      const existing = state?.tools !== undefined;
      // Initial acquisition owns its deadline and cleanup. A second timer
      // could detach this waiter before that owner has disposed a failed client.
      const tools = await connect(signal);
      if (!existing) return tools;
      const owner = state;
      if (owner === undefined)
        throw new AnalysisProtocolError("JEB MCP client failed to connect");
      const discoverySignal =
        signal === undefined
          ? owner.signal.signal
          : AbortSignal.any([signal, owner.signal.signal]);
      const deadline = new ProviderStartupDeadline(
        discoveryTimeoutMs,
        discoverySignal,
      );
      try {
        const refreshed = await readToolNames(owner.client, deadline.signal);
        owner.tools = refreshed;
        return refreshed;
      } catch (cause: unknown) {
        if (deadline.interruption === "timeout")
          throw new AnalysisTimeoutError(
            "jeb_mcp_catalog",
            discoveryTimeoutMs,
            { cause },
          );
        if (deadline.interruption === "cancelled")
          throw new AnalysisCancelledError("jeb_mcp_catalog", { cause });
        throw cause;
      } finally {
        deadline.dispose();
      }
    },
    async call(name, args, signal) {
      await connect(signal);
      const owner = state;
      if (owner === undefined || owner.tools === undefined)
        throw new AnalysisProtocolError("JEB MCP client failed to connect");
      const requestSignal =
        signal === undefined
          ? owner.signal.signal
          : AbortSignal.any([signal, owner.signal.signal]);
      const deadline = new ProviderStartupDeadline(
        requestTimeoutMs,
        requestSignal,
      );
      try {
        const result = await owner.client.callTool(
          { name, arguments: args },
          { timeout: deadline.remainingMs(), signal: deadline.signal },
        );
        return decodeJebToolResult(result);
      } catch (cause: unknown) {
        if (deadline.interruption === "timeout")
          throw new AnalysisTimeoutError(name, requestTimeoutMs, { cause });
        if (requestSignal.aborted)
          throw new AnalysisCancelledError(name, { cause });
        if (
          cause instanceof SdkError &&
          cause.code === SdkErrorCode.RequestTimeout
        )
          throw new AnalysisTimeoutError(name, requestTimeoutMs, { cause });
        throw cause;
      } finally {
        deadline.dispose();
      }
    },
    async close() {
      closed = true;
      if (closing !== undefined) return closing;
      const operation = (async () => {
        const owner = state;
        if (owner === undefined) return;
        owner.tools = undefined;
        owner.signal.abort();
        if (owner.acquisition !== undefined)
          await owner.acquisition.catch(() => undefined);
        if (state === owner) await dispose(owner);
      })();
      closing = operation;
      try {
        await operation;
      } finally {
        if (closing === operation) closing = undefined;
      }
    },
  };
};

const readToolNames = async (
  client: Client,
  signal: AbortSignal,
): Promise<readonly string[]> => {
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    // listTools without a cursor aggregates and caches every page in SDK v2.
    // This owner needs single pages to bound retained names and the whole walk.
    const page = await client.request(
      {
        method: "tools/list",
        ...(cursor === undefined ? {} : { params: { cursor } }),
      },
      { signal },
    );
    signal.throwIfAborted();
    for (const tool of page.tools)
      if (RELEVANT_ENGINE_TOOLS.has(tool.name)) names.add(tool.name);
    if (names.size === RELEVANT_ENGINE_TOOLS.size) return [...names];
    const next = page.nextCursor;
    if (next !== undefined && next === cursor)
      throw new AnalysisProtocolError("JEB MCP repeated a tool catalog cursor");
    cursor = next;
  } while (cursor !== undefined);
  return [...names];
};
