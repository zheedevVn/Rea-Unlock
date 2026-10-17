import type { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";

/** Hash one verifier input and transfer failed-close ownership to its scope. */
export function hashVerifierFile(
  path: string,
  resources: Pick<ArtifactResourceScope, "retain">,
): Promise<{ readonly bytes: number; readonly sha256: string }>;
