import type { ArtifactInventorySnapshot } from "../../domain/artifactInventorySnapshot.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { compositeKey } from "../../domain/unicodeCodePointOrder.js";
import {
  completeApplicationCoverage,
  partialApplicationCoverage,
  truncatedApplicationCoverage,
  type ApplicationGraphEvidence,
} from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import type { ApplicationNode } from "../../domain/javascript/javascriptApplicationGraphSchemas.js";
import type { JavaScriptSourceRange } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type {
  JavaScriptHtmlInlineScriptsObservation,
  JavaScriptModuleArtifactAnalysis,
  JavaScriptArtifactAnalysisScope,
} from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptUnanalyzedArtifactLookup } from "../../domain/javascript/javascriptArtifactFiles.js";
import { HTML_INLINE_SCRIPT_LOCATION_LIMIT } from "../../domain/javascript/htmlArtifactReferences.js";
import type {
  JavaScriptArtifactFile,
  JavaScriptArtifactFileSet,
  JavaScriptArtifactFileKind,
} from "../../domain/javascript/javascriptArtifactFiles.js";
import { JavaScriptArtifactGraphAccumulator } from "./JavaScriptArtifactGraphAccumulator.js";
import {
  artifactObservationEvidence,
  astObservationEvidence,
  staticInferenceEvidence,
  unavailableStaticEvidence,
} from "./JavaScriptArtifactGraphEvidence.js";
import {
  artifactPathResolutionProperties,
  resolveArtifactPathByContext,
  type ArtifactPathResolution,
} from "./JavaScriptArtifactPathResolution.js";

/** Mutable graph-construction state scoped to one reconstruction. */
export interface JavaScriptArtifactGraphContext {
  readonly accumulator: JavaScriptArtifactGraphAccumulator;
  readonly snapshot: ArtifactInventorySnapshot;
  readonly fileSet: JavaScriptArtifactFileSet;
  readonly analysis: JavaScriptModuleArtifactAnalysis;
  readonly directoryPaths: ReadonlySet<string>;
  readonly root: ApplicationNode;
  readonly filesByPath: ReadonlyMap<string, JavaScriptArtifactFile>;
  /** Borrowed inventory lookup for present files outside the source projection. */
  readonly unanalyzedFiles: JavaScriptUnanalyzedArtifactLookup | undefined;
  readonly fileNodes: Map<string, ApplicationNode>;
  readonly assetNodes: Map<string, ApplicationNode>;
  readonly sourceModuleNodes: Map<string, ApplicationNode>;
  readonly chunkNodes: Map<string, ApplicationNode>;
  readonly moduleNodes: Map<string, ApplicationNode>;
  readonly containerNodes: Map<string, ApplicationNode>;
}

/** Evidence coverage shape shared by reconstruction graph helpers. */
export type JavaScriptArtifactGraphCoverage =
  ApplicationGraphEvidence["coverage"];

/** Direct artifact-containment edge values. */
export interface ContainsEdgeInput {
  readonly source: ApplicationNode;
  readonly target: ApplicationNode;
  readonly file: JavaScriptArtifactFile;
  readonly operation: string;
}

/** Exact AST containment edge values. */
export interface AstEdgeInput {
  readonly source: ApplicationNode;
  readonly target: ApplicationNode;
  readonly file: JavaScriptArtifactFile;
  readonly range: JavaScriptSourceRange;
  readonly coverage: JavaScriptArtifactGraphCoverage;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Inferred static relationship edge values. */
export interface InferenceEdgeInput extends AstEdgeInput {
  readonly limitations?: readonly string[];
  readonly confidence?: "high" | "medium" | "low";
  readonly relation:
    | "imports"
    | "loads"
    | "maps_to"
    | "exposes"
    | "calls"
    | "persists_to";
}

/** Electron role identity and static discovery evidence. */
export interface RoleNodeInput {
  readonly kind: "electron-main" | "electron-preload" | "electron-renderer";
  readonly anchor: JavaScriptArtifactFile;
  readonly resolution: ArtifactPathResolution;
  readonly mechanism: string;
  readonly range?: JavaScriptSourceRange;
  readonly coverage?: JavaScriptArtifactGraphCoverage;
}

/** Resolution from an inferred Electron role to an artifact asset. */
export interface RoleAssetLinkInput {
  readonly role: ApplicationNode;
  readonly anchor: JavaScriptArtifactFile;
  readonly resolution: ArtifactPathResolution;
  readonly range?: JavaScriptSourceRange;
  readonly coverage?: JavaScriptArtifactGraphCoverage;
}

/** An explicit processing/selection gap with the applicable phase's authority. */
export interface UnavailableParseInput {
  readonly file: JavaScriptArtifactFile;
  readonly asset: ApplicationNode;
  readonly operation: string;
  readonly authority: JavaScriptArtifactAnalysisScope["authority"];
  readonly limitation: string;
  readonly failure?: JsonValue;
  readonly limits?: JavaScriptArtifactGraphCoverage["limits"];
  /** Items a named limit dropped from this gap's own record, when known. */
  readonly omittedCount?: number;
  /** Structured details of the gap, such as the exact omitted locations. */
  readonly details?: Readonly<Record<string, JsonValue>>;
}

/** The per-file bound on retained inline HTML script locations. */
export const HTML_INLINE_SCRIPT_LOCATION_COVERAGE_LIMIT = {
  name: "html_inline_script_locations_per_file",
  value: HTML_INLINE_SCRIPT_LOCATION_LIMIT,
  unit: "items",
} as const;

/** Count inline HTML script locations dropped by the per-file bound. */
export const omittedHtmlInlineScriptLocations = (
  files: readonly JavaScriptHtmlInlineScriptsObservation[],
): number =>
  files.reduce(
    (omitted, { script_count, scripts }) =>
      omitted + script_count - scripts.length,
    0,
  );

/** Add a direct artifact-containment edge. */
export const addArtifactContainsEdge = (
  context: JavaScriptArtifactGraphContext,
  input: ContainsEdgeInput,
): void => {
  context.accumulator.addEdge({
    source_node_id: input.source.node_id,
    target_node_id: input.target.node_id,
    relation: "contains",
    properties: { path: input.file.path },
    evidence: artifactObservationEvidence({
      sha256:
        input.operation === "inventory-entry"
          ? input.file.container_sha256
          : input.file.sha256,
      path: input.file.path,
      operation: input.operation,
      coverage: completeApplicationCoverage(),
    }),
  });
};

/** Add an exact AST containment edge. */
export const addAstContainsEdge = (
  context: JavaScriptArtifactGraphContext,
  input: AstEdgeInput,
): void => {
  context.accumulator.addEdge({
    source_node_id: input.source.node_id,
    target_node_id: input.target.node_id,
    relation: "contains",
    properties: input.properties,
    evidence: astObservationEvidence({
      sha256: input.file.sha256,
      path: input.file.path,
      range: input.range,
      operation: "map-bundler-structure",
      coverage: input.coverage,
    }),
  });
};

/** Add an explicitly inferred static relationship edge. */
export const addStaticInferenceEdge = (
  context: JavaScriptArtifactGraphContext,
  input: InferenceEdgeInput,
): void => {
  context.accumulator.addEdge({
    source_node_id: input.source.node_id,
    target_node_id: input.target.node_id,
    relation: input.relation,
    properties: input.properties,
    evidence: staticInferenceEvidence({
      sha256: input.file.sha256,
      path: input.file.path,
      range: input.range,
      operation: "map-static-relationship",
      coverage: input.coverage,
      ...(input.confidence === undefined
        ? {}
        : { confidence: input.confidence }),
      ...(input.limitations === undefined
        ? {}
        : { limitations: input.limitations }),
    }),
  });
};

/** Preserve a static parse or approval gap as an explicit unknown scope. */
export const addUnavailableStaticParseScope = (
  context: JavaScriptArtifactGraphContext,
  input: UnavailableParseInput,
): void => {
  const node = context.accumulator.addNode({
    kind: "unknown",
    identity: artifactLocalIdentity(
      input.file.sha256,
      "static-parse-scope",
      `${input.operation}:${input.file.path}`,
    ),
    observations: [
      {
        label: `${input.file.path} parse scope`,
        properties: {
          // Details come first so they cannot replace the gap's own fields.
          ...input.details,
          path: input.file.path,
          operation: input.operation,
          limitation: input.limitation,
          ...(input.failure === undefined
            ? {}
            : { analysis_failure: input.failure }),
        },
        evidence: unavailableStaticEvidence({
          authority: input.authority,
          sha256: input.file.sha256,
          path: input.file.path,
          operation: input.operation,
          coverage:
            input.omittedCount !== undefined && input.omittedCount > 0
              ? truncatedApplicationCoverage(
                  input.limits ?? [],
                  input.omittedCount,
                )
              : partialApplicationCoverage(input.limits ?? [], null),
          limitation: input.limitation,
        }),
      },
    ],
  });
  context.accumulator.addEdge({
    source_node_id: input.asset.node_id,
    target_node_id: node.node_id,
    relation: "contains",
    properties: { scope: "unavailable-static-analysis" },
    evidence: artifactObservationEvidence({
      sha256: input.file.sha256,
      path: input.file.path,
      operation: "associate-unavailable-parse-scope",
      coverage: completeApplicationCoverage(),
    }),
  });
};

/** Coverage for one bounded JavaScript AST analysis. */
export const javascriptAnalysisCoverage = (
  analysis: NonNullable<
    JavaScriptModuleArtifactAnalysis["files"][number]["javascript"]
  >,
): JavaScriptArtifactGraphCoverage =>
  analysis.parse_status === "complete"
    ? completeApplicationCoverage()
    : partialApplicationCoverage([], null);

/** Stable identity for a fact scoped to one exact artifact. */
export const artifactLocalIdentity = (
  sha256: string,
  namespace: string,
  key: string,
) => ({
  strategy: "artifact-local-key" as const,
  stability: "artifact-version" as const,
  artifact_sha256: sha256,
  namespace,
  key,
});

/** Select the graph node kind for one inventoried relevant file. */
export const artifactFileNodeKind = (
  kind: JavaScriptArtifactFileKind,
): ApplicationNode["kind"] =>
  kind === "javascript"
    ? "javascript-asset"
    : kind === "source-map"
      ? "source-map"
      : kind === "native-addon"
        ? "native-addon"
        : "artifact";

/** Create or merge an Electron role inferred from static syntax or metadata. */
export const createElectronRoleNode = (
  context: JavaScriptArtifactGraphContext,
  input: RoleNodeInput,
): ApplicationNode =>
  context.accumulator.addNode({
    kind: input.kind,
    identity: artifactLocalIdentity(
      input.anchor.sha256,
      "electron-role",
      `${input.kind}:${input.resolution.resolution_context}:${input.resolution.resolved_path ?? input.resolution.declared_path}`,
    ),
    observations: [
      {
        label: input.resolution.resolved_path ?? input.resolution.declared_path,
        properties: {
          ...artifactPathResolutionProperties(input.resolution),
          declared_path: input.resolution.declared_path,
          resolution_context: input.resolution.resolution_context,
          resolved_path: input.resolution.resolved_path,
          resolution_status: input.resolution.resolution_status,
          limitations: input.resolution.limitations,
          mechanism: input.mechanism,
        },
        evidence: staticInferenceEvidence({
          sha256: input.anchor.sha256,
          path: input.anchor.path,
          operation: "discover-electron-entrypoint",
          coverage: input.coverage ?? completeApplicationCoverage(),
          limitations: input.resolution.limitations,
          ...(input.range === undefined ? {} : { range: input.range }),
        }),
      },
    ],
  });

/** Resolve an Electron role to an inventoried asset when available. */
export const linkElectronRoleToAsset = (
  context: JavaScriptArtifactGraphContext,
  input: RoleAssetLinkInput,
): void => {
  const path = input.resolution.resolved_path;
  if (path === null) return;
  const asset = context.assetNodes.get(path) ?? context.fileNodes.get(path);
  if (asset === undefined) return;
  context.accumulator.addEdge({
    source_node_id: input.role.node_id,
    target_node_id: asset.node_id,
    relation: "maps_to",
    properties: {
      declared_path: input.resolution.declared_path,
      resolution_context: input.resolution.resolution_context,
      resolved_path: path,
      resolution_status: input.resolution.resolution_status,
    },
    evidence: staticInferenceEvidence({
      sha256: input.anchor.sha256,
      path: input.anchor.path,
      operation: "resolve-electron-entrypoint",
      coverage: input.coverage ?? completeApplicationCoverage(),
      limitations: input.resolution.limitations,
      ...(input.range === undefined ? {} : { range: input.range }),
    }),
  });
};

/**
 * Disclose relationships omitted because they resolved to their own source;
 * the application graph forbids self-referential edges.
 */
export const selfReferenceOmissions = (
  count: number,
  noun: readonly [singular: string, plural: string],
  owner: string,
): string[] =>
  count === 0
    ? []
    : [
        `${String(count)} ${count === 1 ? noun[0] : noun[1]} resolved back to ${owner} itself and ${count === 1 ? "was" : "were"} omitted; application graph edges cannot be self-referential.`,
      ];

/** Deterministic key for one recovered module inside a bundle asset. */
export const moduleLookupKey = (
  path: string,
  runtime: string,
  moduleKey: string,
): string => compositeKey([path, runtime, moduleKey]);

/** Deterministic key for one recovered bundler chunk inside a bundle asset. */
export const chunkLookupKey = (
  path: string,
  runtime: string,
  chunkKey: string,
): string => compositeKey([path, runtime, chunkKey]);

/** Resolve a relative static specifier without escaping the artifact root. */
export const resolveArtifactPath = (
  specifier: string,
  sourcePath: string,
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
  moduleKind?: "import" | "require" | "compiler-dependent",
  directoryPaths?: ReadonlySet<string>,
): string | null =>
  resolveArtifactPathByContext({
    declaredPath: specifier,
    sourcePath,
    context: "module-specifier",
    files,
    ...(directoryPaths === undefined ? {} : { directoryPaths }),
    ...(moduleKind === undefined ? {} : { moduleKind }),
  }).resolved_path;

/** Locate the recovered module that owns a static finding. */
export const sourceNodeFor = (
  context: JavaScriptArtifactGraphContext,
  path: string,
  moduleKey: string | null,
  runtime?: string,
): ApplicationNode | undefined =>
  moduleKey === null
    ? context.sourceModuleNodes.get(path)
    : runtime === undefined
      ? undefined
      : context.moduleNodes.get(moduleLookupKey(path, runtime, moduleKey));
