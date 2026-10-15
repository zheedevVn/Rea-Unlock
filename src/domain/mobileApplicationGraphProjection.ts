import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import {
  hasCompleteInventoryCoverage,
  type ParsedInventorySet,
} from "./artifactInventoryEvidence.js";
import { evidenceSchema } from "./evidence.js";
import { digestSchema } from "./digests.js";
import { prefixedDigestSchema } from "./digests.js";
import {
  bridgeCandidateCoverageSchema,
  projectCartesianCandidates,
} from "./bridgeCandidateProjection.js";

/** Evidence-scoped identifier schemas shared by application graph projections. */
export const projectionEvidenceIdSchema = prefixedDigestSchema("ev");
export const projectionPathSchema = z.string().min(1);

/** Inventory pages accepted by every application graph projection. */
export const applicationInventoryProjectionInputSchema = z.strictObject({
  inventory_evidence: z.array(evidenceSchema).min(1),
});

/** One authenticated inventory entry retained by application graph projections. */
export const projectedComponentSchema = z.strictObject({
  path: projectionPathSchema,
  artifact_id: prefixedDigestSchema("art"),
  sha256: digestSchema,
  format: z.string().min(1),
});

/** Inventoried paths whose content identity is unavailable, retained as unknown. */
export const unavailableComponentSchema = z.strictObject({
  path: projectionPathSchema,
  artifact_id: z.null(),
  sha256: z.null(),
  format: z.string().min(1),
  encrypted: z.boolean(),
  limitations: z.array(z.string()),
});

export type ProjectedComponent = z.infer<typeof projectedComponentSchema>;

/** Path-pair hypotheses connecting managed content to a native library. */
export const projectedBridgeCandidateSchema = <
  Basis extends readonly [string, ...string[]],
>(
  basis: Basis,
) =>
  z.strictObject({
    managed_path: projectionPathSchema,
    native_path: projectionPathSchema,
    basis: z.enum(basis),
  });

/** Coverage status combining inventory completeness with a projection budget. */
export const projectionCoverage = (
  inventory: ParsedInventorySet["inventory"],
  budgetComplete: boolean,
): {
  status: "complete-within-inventory" | "partial";
  /** True when all manifest graph-member counts are present, independent of source coverage. */
  inventory_complete: boolean;
} => ({
  status:
    hasCompleteInventoryCoverage(inventory, "container-entries") &&
    budgetComplete
      ? ("complete-within-inventory" as const)
      : ("partial" as const),
  inventory_complete: inventory.complete,
});

/** Flatten every inventoried occurrence into authenticated path components. */
export const projectedComponents = (
  inventory: ParsedInventorySet["inventory"],
): ProjectedComponent[] => {
  const nodes = new Map(
    inventory.nodes.map((node) => [node.artifact_id, node]),
  );
  return inventory.occurrences
    .filter(
      (occurrence) =>
        occurrence.artifact_id !== null && occurrence.logical_path !== ".",
    )
    .map((occurrence) => {
      const node = nodes.get(occurrence.artifact_id ?? "");
      if (node === undefined)
        throw new TypeError(
          "Application projection occurrence has no artifact node",
        );
      return {
        path: occurrence.logical_path,
        artifact_id: node.artifact_id,
        sha256: node.sha256,
        format: occurrence.artifact_format,
      } satisfies ProjectedComponent;
    });
};

export const unavailableComponents = (
  inventory: ParsedInventorySet["inventory"],
) =>
  inventory.occurrences
    .filter(
      (occurrence) =>
        occurrence.logical_path !== "." && occurrence.artifact_id === null,
    )
    .map((occurrence) => ({
      path: occurrence.logical_path,
      artifact_id: null,
      sha256: null,
      format: occurrence.artifact_format,
      encrypted: occurrence.encrypted,
      limitations: occurrence.limitations,
    }));

export { bridgeCandidateCoverageSchema, projectCartesianCandidates };

/** Digest a canonical JSON projection payload for its stable identifier. */
export const projectionDigest = (value: unknown, label: string): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError(`${label} is not canonical JSON`);
  return createHash("sha256").update(encoded).digest("hex");
};
