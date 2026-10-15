import * as t from "@babel/types";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

import { htmlUrlText, stripQueryAndFragment } from "../artifactPathSyntax.js";
import { sanitizeEndpointCandidate } from "../browserObservation.js";
import {
  addFindingOnce,
  addLocatedFinding,
} from "./javascriptStaticAnalysisFindings.js";
import {
  STATIC_ROUTE_CALL_NAMES,
  argumentNode,
  argumentValue,
  calleeName,
  endpointArgument as endpointArgumentHelper,
  prefixedArgument,
  range,
  rangeForOffsets,
  sourceSlice,
  staticPath,
  staticPathResolutionContext,
  storageKind,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import type {
  JavaScriptAnalysisAccumulator as AnalysisAccumulator,
  JavaScriptEndpointInput as EndpointInput,
  JavaScriptFindingContext as FindingContext,
  JavaScriptReferenceInput as ReferenceInput,
} from "./javascriptStaticAnalysisState.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  isUnmodifiedGlobalReference,
  isUnmodifiedImportMetaUrl,
} from "./javascriptSemanticAmbientWrites.js";
import {
  semanticFactoryLoaderMemberAt,
  semanticFactoryRequireLoaderAt,
  semanticRequireLoaderAt,
} from "./javascriptSemanticRequireOrigin.js";

type JavaScriptCallLike =
  | t.CallExpression
  | t.OptionalCallExpression
  | t.NewExpression;

/** Inspect one call or new expression for references, endpoints, storage, and roles. */
export const inspectCall = (
  source: string,
  node: JavaScriptCallLike,
  context: FindingContext,
  bindings: JavaScriptSemanticAnalysisState,
): void => {
  const { accumulator } = context;
  const name = calleeName(node.callee);
  const first = stringValue(node.arguments[0]);
  const requireCall = requireCallSpecifier(node, bindings, context);
  if (requireCall !== null)
    addReference(context, {
      node,
      kind: "require",
      specifier: requireCall.specifier,
    });
  const chunkLoad = chunkLoadSpecifier(node, bindings, context);
  if (chunkLoad !== null)
    addReference(context, {
      node,
      kind: "dynamic-import",
      specifier: chunkLoad.specifier,
    });
  for (const specifier of vitePreloadDependencySpecifiers(
    node,
    name,
    context.vitePreloadDependencyTable,
    bindings,
  ))
    addReference(context, { node, kind: "dynamic-import", specifier });
  const worker = t.isNewExpression(node) ? node : undefined;
  const workerConstructor =
    worker === undefined
      ? undefined
      : workerConstructorKind(worker.callee, bindings);
  if (
    workerConstructor !== undefined ||
    name === "Worker" ||
    name.endsWith(".Worker")
  )
    addReference(context, {
      node,
      kind: "worker",
      // A string path is relative to the document base URL in a browser and
      // to the process cwd in Node; the analyzed source's artifact location
      // establishes neither. Only `new URL(path, import.meta.url)` names a
      // location relative to this module.
      specifier:
        workerConstructor === undefined || worker === undefined
          ? undefined
          : workerUrlSpecifier(worker, bindings),
    });
  // Service worker script URLs are also relative to the document base URL.
  if (
    name === "serviceWorker.register" ||
    name.endsWith(".serviceWorker.register")
  )
    addReference(context, {
      node,
      kind: "service-worker",
      specifier: undefined,
    });
  inspectEndpointCall(node, name, first, context);
  inspectStorageCall(node, name, first, context);
  if (first === "audio" || first === "video")
    noteMediaElementPreloads(node, accumulator);
  if (
    (name === "loadFile" || name.endsWith(".loadFile")) &&
    first !== undefined
  )
    addLocatedFinding(context, {
      collection: accumulator.roles,
      key: `role\0renderer\0${first}`,
      node,
      value: {
        role: "renderer",
        path: first,
        resolution_context: "filesystem-expression",
        mechanism: `call:${name}`,
        module_key: null,
        location: range(node),
      },
    });
  if ((name === "loadURL" || name.endsWith(".loadURL")) && first !== undefined)
    addLocatedFinding(context, {
      collection: accumulator.roles,
      key: `role\0renderer\0${first}`,
      node,
      value: {
        role: "renderer",
        path: first,
        resolution_context: "module-specifier",
        mechanism: `call:${name}`,
        module_key: null,
        location: range(node),
      },
    });
};

const workerUrlSpecifier = (
  worker: t.NewExpression,
  bindings: JavaScriptSemanticAnalysisState,
): string | undefined => {
  const argumentExpression = argumentNode(worker.arguments[0]);
  if (argumentExpression === undefined) return undefined;
  const node = unwrapJavaScriptExpression(argumentExpression).node;
  if (!t.isNewExpression(node)) return undefined;
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (
    !isUnmodifiedGlobalReference(callee, bindings, "URL") ||
    !isUnmodifiedImportMetaUrl(argumentNode(node.arguments[1]), bindings)
  )
    return undefined;
  const specifier = stringValue(node.arguments[0]);
  if (specifier === undefined) return undefined;
  const pathname = stripQueryAndFragment(specifier);
  // The module URL's scheme and filesystem/origin root are unavailable. Only
  // relative pathnames can establish a location within the artifact; retain
  // rooted paths and paths requiring URL text normalization as expressions.
  // Malformed percent escapes survive HTTP URL parsing but cannot be converted
  // from a file URL to a Node Worker path. Without the base scheme, keep that
  // ambiguity unknown; query and fragment bytes do not affect pathname lookup.
  return pathname.length > 0 &&
    !pathname.startsWith("/") &&
    !/%(?![0-9a-f]{2})/iu.test(pathname) &&
    stripQueryAndFragment(htmlUrlText(specifier)) === pathname
    ? specifier
    : undefined;
};

const workerConstructorKind = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): "browser" | "node" | undefined => {
  const node = unwrapJavaScriptExpression(callee).node;
  const member =
    t.isMemberExpression(node) &&
    semanticStaticPropertyName(node.property, node.computed) === "Worker";
  const root = unwrapJavaScriptExpression(member ? node.object : node).node;
  if (!t.isIdentifier(root)) return undefined;
  const browserGlobal = member
    ? ["globalThis", "window", "self"].includes(root.name)
    : root.name === "Worker";
  if (browserGlobal && isUnmodifiedGlobalReference(node, bindings, "Worker"))
    return "browser";
  const binding = resolveSemanticBindingState(bindings, root, root.name);
  const [origin] = binding?.directOrigins ?? [];
  // Named ESM exports and module namespace exports are read-only. Default
  // imports and CommonJS objects can replace Worker, so their identity is unknown.
  return binding?.runtimeImport === true &&
    binding.definitions.length === 1 &&
    binding.directOrigins.length === 1 &&
    origin !== undefined &&
    (origin.specifier === "worker_threads" ||
      origin.specifier === "node:worker_threads") &&
    (member
      ? origin.importedPath.length === 0
      : origin.importedPath.length === 1 && origin.importedPath[0] === "Worker")
    ? "node"
    : undefined;
};

// Element factories such as jsx("audio", props) and createElement("video",
// props) carry the HTML media `preload` hint ("none", "metadata", "auto"),
// which never names an Electron preload script.
const noteMediaElementPreloads = (
  node: JavaScriptCallLike,
  accumulator: AnalysisAccumulator,
): void => {
  const props = node.arguments[1];
  if (!t.isObjectExpression(props)) return;
  for (const property of props.properties)
    if (
      t.isObjectProperty(property) &&
      semanticStaticPropertyName(property.key, property.computed) === "preload"
    )
      accumulator.mediaElementPreloads.add(property);
};

const requireCallSpecifier = (
  node: JavaScriptCallLike,
  bindings: JavaScriptSemanticAnalysisState,
  context: FindingContext,
): { readonly specifier: string | undefined } | null => {
  const bareRequire = t.isIdentifier(node.callee, { name: "require" });
  if (bareRequire) {
    const loader = semanticRequireLoaderAt(
      node,
      bindings,
      context.accumulator.factoryRequireBindingIds,
    );
    if (loader === "local") return null;
    if (loader === "unknown") context.accumulator.unknownFindings += 1;
    return {
      specifier:
        loader === "unknown" ? undefined : argumentValue(node.arguments[0]),
    };
  }
  const factoryLoader = semanticFactoryRequireLoaderAt(
    node,
    bindings,
    context.accumulator.factoryRequireBindingIds,
  );
  if (factoryLoader === "factory-loader")
    return {
      specifier: argumentValue(
        node.arguments[
          t.isMemberExpression(unwrapJavaScriptExpression(node.callee).node) ||
          t.isOptionalMemberExpression(
            unwrapJavaScriptExpression(node.callee).node,
          )
            ? 1
            : 0
        ],
      ),
    };
  if (factoryLoader === "unknown") {
    context.accumulator.unknownFindings += 1;
    return { specifier: undefined };
  }
  return null;
};

const chunkLoadSpecifier = (
  node: JavaScriptCallLike,
  bindings: JavaScriptSemanticAnalysisState,
  context: FindingContext,
): { readonly specifier: string | undefined } | null => {
  const loader = semanticFactoryLoaderMemberAt(
    node,
    bindings,
    context.accumulator.factoryRequireBindingIds,
    "e",
  );
  if (loader === undefined) return null;
  if (loader === "unknown") return { specifier: undefined };
  return { specifier: prefixedArgument("chunk:", node.arguments[0]) };
};

const vitePreloadDependencySpecifiers = (
  node: JavaScriptCallLike,
  name: string,
  table: readonly (string | undefined)[] | null,
  bindings: JavaScriptSemanticAnalysisState,
): readonly (string | undefined)[] => {
  if (
    name !== "__vite__mapDeps" ||
    table === null ||
    !t.isArrayExpression(node.arguments[0])
  )
    return [];
  const indexes = node.arguments[0].elements;
  // Explicit cache overrides change which table the helper reads. Retain the
  // call slots as unknown unless every override is statically undefined.
  if (
    !node.arguments
      .slice(1)
      .every((argument) => isExplicitDefaultArgument(argument, bindings))
  )
    return indexes.map(() => undefined);
  return indexes.map((element) => {
    if (element === null || !t.isNumericLiteral(element)) return undefined;
    const index = element.value;
    return Number.isSafeInteger(index) && index >= 0 ? table[index] : undefined;
  });
};

const isExplicitDefaultArgument = (
  argument: t.CallExpression["arguments"][number],
  bindings: JavaScriptSemanticAnalysisState,
): boolean => {
  if (!t.isNode(argument)) return false;
  const value = unwrapJavaScriptExpression(argument).node;
  return (
    (t.isUnaryExpression(value) && value.operator === "void") ||
    (t.isIdentifier(value, { name: "undefined" }) &&
      isUnmodifiedGlobalReference(value, bindings, "undefined"))
  );
};

type ViteMapDepsFunction =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression;

/** Index the canonical Vite helper's cache initializer from parsed syntax. */
export const indexVitePreloadDependencyTable = (
  program: t.Program,
): readonly (string | undefined)[] | null => {
  const helpers: ViteMapDepsFunction[] = [];
  traverseJavaScriptAst(program, {
    enter: (node) => {
      if (t.isFunctionDeclaration(node) && node.id?.name === "__vite__mapDeps")
        helpers.push(node);
      else if (
        t.isVariableDeclarator(node) &&
        t.isIdentifier(node.id, { name: "__vite__mapDeps" })
      ) {
        const init = node.init;
        if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))
          helpers.push(init);
      }
    },
  });
  if (helpers.length !== 1) return null;
  const helper = helpers[0];
  if (helper === undefined) return null;
  const mapParameter = helper.params[1];
  const mapIdentifier = t.isAssignmentPattern(mapParameter)
    ? mapParameter.left
    : mapParameter;
  if (!t.isIdentifier(mapIdentifier)) return [];
  const tables: t.ArrayExpression[] = [];
  traverseJavaScriptAst(helper, {
    skip: (node) => t.isFunction(node),
    enter: (node) => {
      if (
        t.isAssignmentExpression(node) &&
        node.operator === "=" &&
        (t.isMemberExpression(node.left) ||
          t.isOptionalMemberExpression(node.left)) &&
        t.isIdentifier(node.left.object, { name: mapIdentifier.name }) &&
        semanticStaticPropertyName(node.left.property, node.left.computed) ===
          "f" &&
        t.isArrayExpression(node.right)
      )
        tables.push(node.right);
    },
  });
  if (tables.length !== 1) return [];
  const table = tables[0];
  if (table === undefined) return [];
  const dependencies = table.elements.map((element) =>
    element === null || t.isSpreadElement(element)
      ? undefined
      : stringValue(element),
  );
  let escapedOrMutated = false;
  traverseJavaScriptAst(program, {
    skip: (node) => node === helper,
    enter: (node, parent) => {
      if (!t.isIdentifier(node, { name: "__vite__mapDeps" })) return;
      if (
        (parent === helper &&
          t.isFunctionDeclaration(parent) &&
          parent.id === node) ||
        (t.isVariableDeclarator(parent) &&
          parent.init === helper &&
          parent.id === node)
      )
        return;
      if (
        (t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) &&
        parent.callee === node
      )
        return;
      escapedOrMutated = true;
    },
  });
  return escapedOrMutated ? dependencies.map(() => undefined) : dependencies;
};

const inspectEndpointCall = (
  node: JavaScriptCallLike,
  name: string,
  first: string | undefined,
  context: FindingContext,
): void => {
  const route = STATIC_ROUTE_CALL_NAMES.some(
    (candidate) => name === candidate || name.endsWith(`.${candidate}`),
  );
  if (route && first !== undefined)
    addEndpoint(context, {
      node,
      kind: "route",
      value: first,
      mechanism: `call:${name}`,
    });
  const receiverFact = context.openReceiverFacts?.get(node.start ?? -1);
  const endpoint = endpointArgumentHelper(
    name,
    node.arguments,
    node.callee,
    receiverFact,
  );
  if (endpoint !== undefined)
    addEndpoint(context, {
      node,
      kind: "network",
      value: endpoint.value,
      mechanism: `call:${name}`,
      ...(endpoint.kind === "candidate" ? { interpretation: "candidate" } : {}),
    });
};

/** Record tRPC procedures, tRPC link URLs and named GraphQL operations. */
export const inspectRpcNode = (node: t.Node, context: FindingContext): void => {
  const rpc = context.rpcScan.inspect(node);
  if (rpc !== undefined)
    addEndpoint(context, { node, kind: "network", ...rpc });
};

export const inspectRouteProperty = (
  node: t.ObjectProperty,
  context: FindingContext,
): void => {
  const key = semanticStaticPropertyName(node.key, node.computed);
  const value = stringValue(node.value);
  if ((key === "path" || key === "route") && value !== undefined)
    addEndpoint(context, {
      node,
      kind: "route",
      value,
      mechanism: `property:${key}`,
    });
};

export const inspectRoleProperty = (
  node: t.ObjectProperty,
  context: FindingContext,
): void => {
  if (semanticStaticPropertyName(node.key, node.computed) !== "preload") return;
  if (context.accumulator.mediaElementPreloads.has(node)) return;
  const path = staticPath(node.value);
  if (path === undefined) return;
  addLocatedFinding(context, {
    collection: context.accumulator.roles,
    key: `role\0preload\0${path}`,
    node,
    value: {
      role: "preload",
      path,
      resolution_context: staticPathResolutionContext(node.value),
      mechanism: "property:preload",
      module_key: null,
      location: range(node),
    },
  });
};

const inspectStorageCall = (
  node: JavaScriptCallLike,
  name: string,
  first: string | undefined,
  context: FindingContext,
): void => {
  const receiverFact = context.openReceiverFacts?.get(node.start ?? -1);
  const storage =
    receiverFact === "local" ||
    receiverFact === "local-indexed-db" ||
    receiverFact === "local-cache-storage"
      ? undefined
      : receiverFact === "indexed-db"
        ? "indexed-db"
        : receiverFact === "cache-storage"
          ? "cache-storage"
          : storageKind(name);
  if (storage === undefined) return;
  addLocatedFinding(context, {
    collection: context.accumulator.storage,
    key: `storage\0${storage}\0${first ?? ""}`,
    node,
    value: {
      kind: storage,
      name: first ?? null,
      mechanism: `call:${name}`,
      module_key: null,
      location: range(node),
    },
  });
};

export const addReference = (
  context: FindingContext,
  input: ReferenceInput,
): void => {
  const specifier = input.specifier ?? null;
  const reference =
    specifier === null
      ? {
          specifier: null,
          expression: sourceSlice(context.source, input.node),
        }
      : { specifier, expression: null };
  addLocatedFinding(context, {
    collection: context.accumulator.references,
    key: `reference\0${input.kind}\0${reference.specifier ?? reference.expression}`,
    node: input.node,
    value: {
      kind: input.kind,
      ...reference,
      module_key: null,
      location: range(input.node),
    },
  });
};

const addEndpoint = (context: FindingContext, input: EndpointInput): void =>
  addLocatedFinding(context, {
    collection: context.accumulator.endpoints,
    key: `endpoint\0${input.kind}\0${input.interpretation ?? "literal"}\0${input.value}`,
    node: input.node,
    value: {
      kind: input.kind,
      value: sanitizeEndpointCandidate(input.value),
      mechanism: input.mechanism,
      ...(input.interpretation === undefined
        ? {}
        : { interpretation: input.interpretation }),
      module_key: null,
      location: range(input.node),
    },
  });

export const addSourceMapDirectives = (
  source: string,
  comments: readonly t.Comment[],
  accumulator: AnalysisAccumulator,
): void => {
  // Read real comment tokens only; quoted text can contain identical markers.
  // Keep both current/legacy line annotations and minifier block annotations.
  for (const comment of comments) {
    const start = comment.start;
    const end = comment.end;
    if (
      start === undefined ||
      start === null ||
      end === undefined ||
      end === null
    )
      continue;
    // The parser owns comment boundaries. Exclude only the closing block
    // delimiter; an asterisk elsewhere remains part of the declared URL.
    const commentSource = source.slice(
      start,
      comment.type === "CommentBlock" ? end - 2 : end,
    );
    if (
      !(commentSource.startsWith("//") || commentSource.startsWith("/*")) ||
      !(commentSource[2] === "#" || commentSource[2] === "@")
    )
      continue;
    // Single-class searches avoid regex backtracking over unbounded whitespace
    // or inline URLs, which can exhaust the engine stack on two-byte strings.
    const nameOffset = commentSource.slice(3).search(/\S/u);
    if (nameOffset === -1) continue;
    const nameStart = 3 + nameOffset;
    if (!commentSource.startsWith("sourceMappingURL", nameStart)) continue;
    const nameEnd = nameStart + "sourceMappingURL".length;
    const equalsOffset = commentSource.slice(nameEnd).search(/\S/u);
    if (equalsOffset === -1) continue;
    const equalsStart = nameEnd + equalsOffset;
    if (!commentSource.startsWith("=", equalsStart)) continue;
    const urlOffset = commentSource.slice(equalsStart + 1).search(/\S/u);
    if (urlOffset === -1) continue;
    const declaredStart = equalsStart + 1 + urlOffset;
    const terminator = commentSource.slice(declaredStart).search(/\s/u);
    const declaredEnd =
      terminator === -1 ? commentSource.length : declaredStart + terminator;
    if (declaredEnd === declaredStart) continue;
    const declared = commentSource.slice(declaredStart, declaredEnd);
    const location = rangeForOffsets(source, start, start + declaredEnd);
    addFindingOnce(accumulator, `source-map\0${declared}`, () =>
      accumulator.sourceMaps.push({ declared_url: declared, location }),
    );
  }
};
