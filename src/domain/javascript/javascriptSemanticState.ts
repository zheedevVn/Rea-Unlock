import * as t from "@babel/types";

import type {
  JavaScriptSemanticPropertyPath,
  SemanticPropertyPathCoverage,
} from "./javascriptSemanticPropertyPaths.js";

import type {
  JavaScriptModuleOrigin,
  JavaScriptSemanticDefinition,
  JavaScriptSemanticModuleLink,
  JavaScriptSemanticCallable,
  JavaScriptSemanticScope,
} from "./javascriptSemanticIr.js";
import type { JavaScriptModuleResolutionMode } from "./javascriptModuleResolutionMode.js";

/** Internal initializer plus a destructuring/member projection. */
interface JavaScriptSemanticInitializer {
  readonly node: t.Node;
  readonly projection: readonly (string | number | null)[];
  readonly entryBody?: t.BlockStatement;
}

/** Additional references from destructuring copies and possible defaults. */
interface JavaScriptSemanticReferenceInitializer extends JavaScriptSemanticInitializer {
  readonly copyKind?: "object-rest" | "array-rest";
  readonly copyProjectionOffset?: number;
  readonly copyExcludedKeys?: readonly string[];
  readonly copyStartIndex?: number;
  readonly fallbackSources?: readonly JavaScriptSemanticInitializer[];
  readonly requiredSources?: readonly JavaScriptSemanticInitializer[];
}

/** Mutable binding state used only while constructing the immutable IR. */
export interface JavaScriptSemanticMemberEffect {
  readonly path: JavaScriptSemanticPropertyPath;
  readonly node: t.Node | undefined;
}

export interface JavaScriptSemanticRequiredModuleEffect extends JavaScriptSemanticMemberEffect {
  readonly kind: "write" | "escape";
}

export interface JavaScriptSemanticBindingState {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly name: string;
  kind: JavaScriptSemanticDefinition["kind"];
  /** Source declaration form retained internally for CommonJS wrapper bindings. */
  declarationKinds: Set<"var" | "let" | "const" | "using" | "await using">;
  mutable: boolean;
  readonly memberWrites: JavaScriptSemanticMemberEffect[];
  readonly escapedPaths: JavaScriptSemanticMemberEffect[];
  readonly definitions: JavaScriptSemanticDefinition[];
  readonly initializers: JavaScriptSemanticInitializer[];
  readonly referenceInitializers: JavaScriptSemanticReferenceInitializer[];
  readonly directOrigins: JavaScriptModuleOrigin[];
  /** An ECMAScript import that exists at runtime, excluding type-only and import-equals syntax. */
  runtimeImport: boolean;
}

/** Mutable lexical-scope state used only during AST recovery. */
export interface JavaScriptSemanticScopeState {
  readonly scopeId: string;
  readonly parentScopeId: string | null;
  readonly kind: JavaScriptSemanticScope["kind"];
  readonly location: JavaScriptSemanticScope["location"];
  bindingsComplete: boolean;
  readonly bindings: Map<string, JavaScriptSemanticBindingState>;
}

/** Shared state for semantic collection and evaluation. */
export interface JavaScriptSemanticAnalysisState {
  readonly program: t.Program;
  /** Effective loader for static imports in this source artifact. */
  readonly staticImportResolutionMode: JavaScriptModuleResolutionMode;
  readonly parentsByNode: WeakMap<t.Node, t.Node>;
  readonly scopes: JavaScriptSemanticScopeState[];
  readonly scopesById: Map<string, JavaScriptSemanticScopeState>;
  /** Scope boundaries and descendant scopes resolved on demand. */
  readonly scopeByNode: WeakMap<t.Node, JavaScriptSemanticScopeState>;
  readonly bindingsById: Map<string, JavaScriptSemanticBindingState>;
  /** Effects on a cached require exports object, independent of local projections. */
  readonly requiredModuleEffects: Map<
    string,
    JavaScriptSemanticRequiredModuleEffect[]
  >;
  readonly callables: JavaScriptSemanticCallable[];
  readonly callableNodesById: Map<string, t.Node>;
  readonly moduleLinks: JavaScriptSemanticModuleLink[];
  /** Exact calls already represented by binding or dependency links. */
  readonly linkedRequireCalls: WeakSet<t.CallExpression>;
  readonly moduleLinkBindings: WeakMap<
    JavaScriptSemanticModuleLink,
    JavaScriptSemanticBindingState
  >;
  /** Default expressions capture their value at the export statement. */
  readonly defaultExportExpressions: WeakMap<
    JavaScriptSemanticModuleLink,
    t.Node
  >;
  /** Initializer expressions whose write can be skipped by enclosing control flow. */
  readonly conditionallySkippedExpressions: WeakSet<t.Node>;
  /** Unbound identifier writes retain their source sites for capture ordering. */
  readonly ambientBindingWrites: Map<string, t.Node[]>;
  /** Source-local writes, tagged by global, import.meta or CJS module identity. */
  readonly ambientWrites: SemanticPropertyPathCoverage;
  /** Source sites distinguish replacement before an ambient identity capture from later writes. */
  readonly ambientWriteEffects: JavaScriptSemanticMemberEffect[];
}

/**
 * Return one unconditional source initializer for a declared lexical binding.
 * Repeated variable declarations without another initializer do not write it.
 * This establishes a stable source fact only; it does not prove immutability or
 * that the declaration has executed at a particular program point.
 */
export const semanticStableInitializer = (
  binding: JavaScriptSemanticBindingState | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticBindingState["initializers"][number] | undefined => {
  const [initializer] = binding?.initializers ?? [];
  const [definition] = binding?.definitions ?? [];
  return binding !== undefined &&
    ((definition?.kind === "variable" &&
      binding.definitions.every(({ kind }) => kind === "variable")) ||
      (binding.definitions.length === 1 &&
        (definition?.kind === "function" || definition?.kind === "class"))) &&
    binding.initializers.length === 1 &&
    initializer !== undefined &&
    !state.conditionallySkippedExpressions.has(initializer.node)
    ? initializer
    : undefined;
};

/** Return the active scope from a non-empty construction stack. */
export const currentSemanticScope = (
  stack: readonly JavaScriptSemanticScopeState[],
): JavaScriptSemanticScopeState => {
  const scope = stack.at(-1);
  if (scope === undefined) throw new TypeError("Missing semantic scope");
  return scope;
};

/** Create a stable source-position identity for one lexical scope. */
export const semanticScopeId = (
  kind: JavaScriptSemanticScope["kind"],
  node: t.Node,
): string =>
  `scope:${kind}:${String(node.start ?? -1)}:${String(node.end ?? -1)}`;

/** Create the canonical identity used by one binding in a lexical scope. */
export const semanticBindingId = (scopeId: string, name: string): string =>
  `${scopeId}:binding:${encodeURIComponent(name)}`;

/** Resolve one lexical name from the scope containing a node. */
export const resolveSemanticBindingState = (
  state: JavaScriptSemanticAnalysisState,
  node: t.Node,
  name: string,
): JavaScriptSemanticBindingState | undefined => {
  let scope = semanticScopeForNode(state, node);
  while (scope !== undefined) {
    const binding = scope.bindings.get(name);
    if (binding !== undefined) return binding;
    if (!scope.bindingsComplete) return undefined;
    scope =
      scope.parentScopeId === null
        ? undefined
        : state.scopesById.get(scope.parentScopeId);
  }
  return undefined;
};

/** Report whether an omitted binding scope blocks a trustworthy miss. */
export const semanticResolutionBlocked = (
  state: JavaScriptSemanticAnalysisState,
  node: t.Node,
  name: string,
): boolean => {
  let scope = semanticScopeForNode(state, node);
  while (scope !== undefined) {
    if (scope.bindings.has(name)) return false;
    if (!scope.bindingsComplete) return true;
    scope =
      scope.parentScopeId === null
        ? undefined
        : state.scopesById.get(scope.parentScopeId);
  }
  return false;
};

const semanticScopeForNode = (
  state: JavaScriptSemanticAnalysisState,
  node: t.Node,
): JavaScriptSemanticScopeState | undefined => {
  let candidate: t.Node | undefined = node;
  while (candidate !== undefined) {
    const scope = state.scopeByNode.get(candidate);
    if (scope !== undefined) {
      // Repeated references in a deep expression share this ancestry. Cache
      // the traversed path without eagerly indexing nodes never resolved.
      let descendant: t.Node | undefined = node;
      while (descendant !== undefined && descendant !== candidate) {
        state.scopeByNode.set(descendant, scope);
        descendant = state.parentsByNode.get(descendant);
      }
      return scope;
    }
    candidate = state.parentsByNode.get(candidate);
  }
  return undefined;
};

/** Resolve one name starting from an explicitly selected lexical scope. */
export const resolveSemanticBindingFromScope = (
  scope: JavaScriptSemanticScopeState,
  name: string,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticBindingState | undefined => {
  let candidate: JavaScriptSemanticScopeState | undefined = scope;
  while (candidate !== undefined) {
    const binding = candidate.bindings.get(name);
    if (binding !== undefined) return binding;
    if (!candidate.bindingsComplete) return undefined;
    candidate =
      candidate.parentScopeId === null
        ? undefined
        : state.scopesById.get(candidate.parentScopeId);
  }
  return undefined;
};

/** Select the function/program owner for a var declaration. */
export const semanticVariableScope = (
  scope: JavaScriptSemanticScopeState,
  parent: t.Node | null,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptSemanticScopeState => {
  if (!(parent !== null && t.isVariableDeclaration(parent, { kind: "var" })))
    return scope;
  let candidate = scope;
  while (candidate.kind === "block" || candidate.kind === "catch") {
    const outer =
      candidate.parentScopeId === null
        ? undefined
        : state.scopesById.get(candidate.parentScopeId);
    if (outer === undefined) break;
    candidate = outer;
  }
  return candidate;
};

/** Identify a global name only when no lexical or dynamic environment shadows it. */
export const isUnshadowedGlobal = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  name: string,
): boolean =>
  t.isIdentifier(node, { name }) &&
  (resolveSemanticBindingState(state, node, name) === undefined
    ? !semanticResolutionBlocked(state, node, name)
    : isUnmodifiedCommonJsWrapperBinding(node, name, state));

/** A program-level `var` redeclaration still denotes its untouched CJS wrapper parameter. */
export const isUnmodifiedCommonJsWrapperBinding = (
  node: t.Node,
  name: string,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  // Parser sourceType separates explicit modules from script/CommonJS source;
  // specifier resolution mode does not establish that distinction.
  if (
    state.program.sourceType !== "script" ||
    !["module", "exports", "require"].includes(name) ||
    !t.isIdentifier(node, { name })
  )
    return false;
  const binding = resolveSemanticBindingState(state, node, name);
  if (binding === undefined || binding.initializers.length !== 0) return false;
  const scope = state.scopesById.get(binding.scopeId);
  return (
    scope?.kind === "program" &&
    binding.declarationKinds.size > 0 &&
    [...binding.declarationKinds].every((kind) => kind === "var")
  );
};
