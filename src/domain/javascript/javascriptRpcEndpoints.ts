import * as t from "@babel/types";

import {
  unwrapJavaScriptExpression,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";
import { calleeName } from "./javascriptStaticAnalysisHelpers.js";

/** One RPC operation or transport URL recovered from client-side syntax. */
export interface JavaScriptRpcEndpoint {
  readonly value: string;
  readonly mechanism: string;
}

/** Per-source RPC recognition state; feed it every AST node in pre-order. */
export interface JavaScriptRpcScan {
  inspect(node: t.Node): JavaScriptRpcEndpoint | undefined;
}

// tRPC proxies preserve router and procedure names as property names, so they
// survive identifier minification. Method names follow @trpc/react-query and
// @trpc/tanstack-react-query 11.19 documentation; cache-key helpers such as
// queryKey are excluded because they never issue a request.
const TRPC_HOOK_METHODS: ReadonlySet<string> = new Set([
  "useQuery",
  "useSuspenseQuery",
  "useInfiniteQuery",
  "useSuspenseInfiniteQuery",
  "usePrefetchQuery",
  "usePrefetchInfiniteQuery",
  "useMutation",
  "useSubscription",
  "queryOptions",
  "infiniteQueryOptions",
  "mutationOptions",
  "subscriptionOptions",
]);

// @trpc/client 11.19 clientCallTypeMap methods; common outside tRPC (Apollo,
// database pools, stores), so they need corroborating evidence.
const TRPC_REQUEST_METHODS: ReadonlySet<string> = new Set(["query", "mutate"]);
// @trpc/client 11.19 TRPCSubscriptionObserver callbacks; RxJS observers use
// next/error/complete instead.
const TRPC_SUBSCRIPTION_CALLBACKS: ReadonlySet<string> = new Set([
  "onStarted",
  "onData",
  "onError",
  "onStopped",
  "onComplete",
  "onConnectionStateChange",
]);
// @trpc/client 11.19 client factories (createTRPCProxyClient is the
// deprecated alias of createTRPCClient).
const TRPC_CLIENT_FACTORIES: ReadonlySet<string> = new Set([
  "createTRPCClient",
  "createTRPCProxyClient",
]);
// Built-in HTTP links documented by tRPC 11.19 that carry a `url` option.
const TRPC_URL_LINKS: ReadonlySet<string> = new Set([
  "httpLink",
  "httpBatchLink",
  "httpBatchStreamLink",
  "httpSubscriptionLink",
]);
// Literals retained by @trpc/client 11.19 bundles (`this.name`, the default
// accept header key) or by the conventional transport path.
const TRPC_SOURCE_MARKERS = ["TRPCClientError", "trpc-accept", "/trpc"];

// Browser-owned roots whose methods share tRPC names, such as
// navigator.permissions.query.
const BROWSER_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  "window",
  "self",
  "globalThis",
  "document",
  "navigator",
  "location",
  "history",
  "console",
  "performance",
  "screen",
  "top",
  "parent",
  "frames",
]);

const PROCEDURE_SEGMENT = /^[A-Za-z_$][\w$]*$/u;

interface MemberPath {
  readonly root: t.Node;
  /** Non-computed property names from the root outward. */
  readonly properties: readonly string[];
}

/** Read a static member path and the expression it starts from. */
const memberPath = (callee: t.Node): MemberPath | undefined => {
  const reversed: string[] = [];
  let current: t.Node = callee;
  while (
    t.isMemberExpression(current) ||
    t.isOptionalMemberExpression(current)
  ) {
    const property = semanticStaticPropertyKey(
      current.property,
      current.computed,
    );
    if (property === null || !PROCEDURE_SEGMENT.test(property))
      return undefined;
    reversed.push(property);
    current = current.object;
  }
  return { root: current, properties: reversed.reverse() };
};

const objectKeys = (node: t.Node | undefined): readonly string[] =>
  t.isObjectExpression(node)
    ? node.properties.flatMap((property) => {
        if (!t.isObjectProperty(property) && !t.isObjectMethod(property))
          return [];
        const key = semanticStaticPropertyKey(property.key, property.computed);
        return key === null ? [] : [key];
      })
    : [];

/** Later properties own a key; an intervening dynamic write leaves it unknown. */
const objectProperty = (
  node: t.ObjectExpression,
  key: string,
): t.Node | undefined => {
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index];
    if (property === undefined || t.isSpreadElement(property)) return undefined;
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) return undefined;
    if (name === key)
      return t.isObjectProperty(property) ? property.value : undefined;
  }
  return undefined;
};

const objectStringProperty = (
  node: t.ObjectExpression,
  key: string,
): string | undefined => {
  const value = objectProperty(node, key);
  return t.isStringLiteral(value) ? value.value : undefined;
};

/**
 * Find source-body string values owned by a GraphQL Source-shaped literal.
 * A later duplicate or spread can make the effective `body` unknown, but the
 * earlier strings still belong to this object and must not become standalone
 * operation findings during the string scan.
 */
const graphqlSourceBodyLiterals = (
  node: t.ObjectExpression,
): readonly t.StringLiteral[] | undefined => {
  const bodyStrings = (object: t.ObjectExpression) =>
    object.properties.flatMap((property) =>
      t.isObjectProperty(property) &&
      semanticStaticPropertyKey(property.key, property.computed) === "body" &&
      t.isStringLiteral(property.value)
        ? [property.value]
        : [],
    );
  const bodies = bodyStrings(node);
  const hasLocationOffset = node.properties.some(
    (property) =>
      t.isObjectProperty(property) &&
      semanticStaticPropertyKey(property.key, property.computed) ===
        "locationOffset",
  );
  if (!hasLocationOffset) return undefined;

  // Inline object spreads can own additional body values which the surrounding
  // Source object may select. Include only body-key string literals from those
  // spread values; ordinary strings elsewhere in the object remain scannable.
  const visited = new WeakSet<t.ObjectExpression>();
  visited.add(node);
  const pending = node.properties.flatMap((property) => {
    if (!t.isSpreadElement(property)) return [];
    const spread = unwrapJavaScriptExpression(property.argument).node;
    return t.isObjectExpression(spread) ? [spread] : [];
  });
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    bodies.push(...bodyStrings(current));
    for (const property of current.properties) {
      if (t.isSpreadElement(property)) {
        const spread = unwrapJavaScriptExpression(property.argument).node;
        if (t.isObjectExpression(spread)) pending.push(spread);
      }
    }
  }
  return bodies.length === 0 ? undefined : bodies;
};

const GRAPHQL_OPERATION_TYPES: ReadonlySet<string> = new Set([
  "query",
  "mutation",
  "subscription",
]);

// GraphQL October 2021 §2.1.7: ignored BOM, tab/space, line endings, commas;
// comments are consumed separately below.
const isGraphqlIgnoredCharacter = (character: string): boolean =>
  character === "," ||
  character === "\uFEFF" ||
  character === "\t" ||
  character === " " ||
  character === "\n" ||
  character === "\r";

/** Return the first offset after GraphQL ignored tokens. */
const skipGraphqlIgnored = (text: string, start: number): number => {
  const limit = text.length;
  let index = start;
  while (index < limit) {
    const character = text.charAt(index);
    if (isGraphqlIgnoredCharacter(character)) index += 1;
    else if (character === "#") {
      while (index < limit && !/[\n\r]/u.test(text.charAt(index))) index += 1;
    } else break;
  }
  return index;
};

const graphqlNameAt = (
  text: string,
  index: number,
): { readonly value: string; readonly end: number } | undefined => {
  const name = /^[_A-Za-z][_0-9A-Za-z]*/u.exec(text.slice(index))?.[0];
  return name === undefined
    ? undefined
    : { value: name, end: index + name.length };
};

/** Recover a named operation from GraphQL document text. */
export const graphqlOperationFromText = (
  text: string,
): JavaScriptRpcEndpoint | undefined => {
  const type = graphqlNameAt(text, skipGraphqlIgnored(text, 0));
  if (type === undefined || !GRAPHQL_OPERATION_TYPES.has(type.value))
    return undefined;
  const name = graphqlNameAt(text, skipGraphqlIgnored(text, type.end));
  if (name === undefined) return undefined;
  const index = skipGraphqlIgnored(text, name.end);
  const next = text.charAt(index);
  // Keep the existing bounded recognition scope: a named operation followed
  // by variable definitions, a directive, or a selection set with a field.
  const hasHeader =
    next === "("
      ? text.charAt(skipGraphqlIgnored(text, index + 1)) === "$"
      : (next === "@" || next === "{") &&
        graphqlNameAt(text, skipGraphqlIgnored(text, index + 1)) !== undefined;
  return hasHeader
    ? { value: name.value, mechanism: `graphql:${type.value}` }
    : undefined;
};

/** Recover a named operation from a precompiled GraphQL document object. */
export const graphqlOperationFromDocumentNode = (
  node: t.ObjectExpression,
): JavaScriptRpcEndpoint | undefined => {
  if (objectStringProperty(node, "kind") !== "OperationDefinition")
    return undefined;
  const type = objectStringProperty(node, "operation");
  if (type === undefined || !GRAPHQL_OPERATION_TYPES.has(type))
    return undefined;
  const name = objectProperty(node, "name");
  if (
    !t.isObjectExpression(name) ||
    objectStringProperty(name, "kind") !== "Name"
  )
    return undefined;
  const value = objectStringProperty(name, "value");
  return value === undefined
    ? undefined
    : { value, mechanism: `graphql:${type}` };
};

/** Bundlers use `(0, imported.factory)` to call an import without a receiver. */
const rpcFactoryName = (callee: t.Node): string => {
  let current = unwrapJavaScriptExpression(callee).node;
  while (t.isSequenceExpression(current)) {
    const last = current.expressions.at(-1);
    if (last === undefined) return "";
    current = unwrapJavaScriptExpression(last).node;
  }
  return calleeName(current);
};

/** Whether an initializer has the syntax of a documented tRPC client factory. */
export const isJavaScriptRpcClientFactory = (node: t.Node): boolean => {
  const call = unwrapJavaScriptExpression(node).node;
  return (
    (t.isCallExpression(call) || t.isOptionalCallExpression(call)) &&
    TRPC_CLIENT_FACTORIES.has(
      rpcFactoryName(call.callee).split(".").pop() ?? "",
    )
  );
};

/** Recover the literal `url` option passed to a documented tRPC HTTP link. */
const trpcLinkUrl = (
  node: t.CallExpression | t.OptionalCallExpression,
): JavaScriptRpcEndpoint | undefined => {
  const name = rpcFactoryName(node.callee);
  const factory = name.slice(name.lastIndexOf(".") + 1);
  if (!TRPC_URL_LINKS.has(factory)) return undefined;
  const options = node.arguments[0];
  if (!t.isObjectExpression(options)) return undefined;
  const url = objectStringProperty(options, "url");
  return url === undefined
    ? undefined
    : { value: url, mechanism: `trpc:link:${factory}` };
};

/**
 * Create the per-source scan. Hook and option-factory methods are distinctive.
 * `query`/`mutate` need a root bound to a tRPC client factory, or a tRPC source
 * marker with a router path of at least two segments; `subscribe` needs the
 * marker and a tRPC observer argument. `this` roots, browser globals and RTK
 * Query `endpoints` chains are never procedures.
 */
export const createJavaScriptRpcScan = (
  source: string,
  clientRoots: ReadonlySet<t.Node>,
): JavaScriptRpcScan => {
  let marker: boolean | undefined;
  const hasMarker = (): boolean =>
    (marker ??= TRPC_SOURCE_MARKERS.some((value) => source.includes(value)));
  // graphql-tag documents retain source text in loc.source.body. Keep each
  // direct body literal owned by a Source-shaped object out of the independent
  // string scan, including duplicates that a later property or spread hides.
  const graphqlDocumentSourceBodies = new WeakSet<t.Node>();

  const procedure = (
    node: t.CallExpression | t.OptionalCallExpression,
  ): JavaScriptRpcEndpoint | undefined => {
    const path = memberPath(node.callee);
    if (path === undefined || t.isThisExpression(path.root)) return undefined;
    if (t.isIdentifier(path.root) && BROWSER_GLOBAL_NAMES.has(path.root.name))
      return undefined;
    const method = path.properties[path.properties.length - 1];
    const segments = path.properties.slice(0, -1);
    const first = segments[0];
    if (method === undefined || first === undefined) return undefined;
    if (BROWSER_GLOBAL_NAMES.has(first) || segments.includes("endpoints"))
      return undefined;
    const bound = clientRoots.has(path.root);
    const recognized = TRPC_HOOK_METHODS.has(method)
      ? true
      : TRPC_REQUEST_METHODS.has(method)
        ? bound || (segments.length >= 2 && hasMarker())
        : method === "subscribe" &&
          (bound || hasMarker()) &&
          objectKeys(node.arguments[1]).some((key) =>
            TRPC_SUBSCRIPTION_CALLBACKS.has(key),
          );
    return recognized
      ? { value: segments.join("."), mechanism: `trpc:procedure:${method}` }
      : undefined;
  };

  return {
    inspect: (node) => {
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        return trpcLinkUrl(node) ?? procedure(node);
      if (t.isObjectExpression(node)) {
        const bodies = graphqlSourceBodyLiterals(node);
        if (bodies !== undefined) {
          for (const body of bodies) graphqlDocumentSourceBodies.add(body);
          return undefined;
        }
        return graphqlOperationFromDocumentNode(node);
      }
      if (t.isStringLiteral(node))
        return graphqlDocumentSourceBodies.has(node)
          ? undefined
          : graphqlOperationFromText(node.value);
      if (t.isTemplateLiteral(node)) {
        // Interpolations may contain fragment definitions. Continue only
        // across quasis that contain ignored tokens; prose or dynamic text
        // before an operation prevents claiming a later operation belongs to
        // this document prefix.
        for (const quasi of node.quasis) {
          const cooked = quasi.value.cooked;
          if (cooked === undefined || cooked === null) return undefined;
          if (skipGraphqlIgnored(cooked, 0) === cooked.length) continue;
          return graphqlOperationFromText(cooked);
        }
        return undefined;
      }
      return undefined;
    },
  };
};
