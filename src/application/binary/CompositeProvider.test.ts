import { expect, it, vi } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../AnalysisProvider.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok } from "../../domain/result.js";
import { CompositeProvider } from "./CompositeProvider.js";

const identity = (id: string): ProviderIdentity => ({
  id,
  name: id,
  version: "1",
});

const operationCapability = (
  provider: ProviderIdentity,
  operation: Exclude<AnalysisOperation, "health">,
): CapabilityDescriptor => ({
  provider,
  operation,
  available: true,
  reason: null,
  effects: {
    mutatesArtifact: false,
    launchesProcess: false,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});

const failingProvider = (
  id: string,
  operation: Exclude<AnalysisOperation, "health">,
  resource: string,
) => {
  const providerIdentity = identity(id);
  const cleanupError = new ProviderCleanupError(id, [resource], {
    reason: `${id} cleanup is unresolved`,
    child_marker: `${id}-detail`,
  });
  const close = vi.fn(async () => err(cleanupError));
  const provider: AnalysisProvider = {
    identity: () => providerIdentity,
    capabilities: () => [operationCapability(providerIdentity, operation)],
    createClient: (): AnalysisClient => ({
      execute: (name) =>
        Promise.resolve(
          ok(createAnalysisExecution(`${id}:${name}`, providerIdentity)),
        ),
      close,
    }),
  };
  return { provider, close, cleanupError };
};

const executableTarget = {
  path: "/tmp/fixture",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
} as const;

it("retains every failed child resource across composite cleanup retries", async () => {
  const left = failingProvider("provider-left", "address_name", "left-db");
  const right = failingProvider("provider-right", "procedure_info", "right-db");
  const client = new CompositeProvider([
    left.provider,
    right.provider,
  ]).createClient(executableTarget);

  expect((await client.execute("address_name", {})).ok).toBe(true);
  expect((await client.execute("procedure_info", {})).ok).toBe(true);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const closed = await client.close();
    expect(closed.ok).toBe(false);
    if (closed.ok) throw new Error("Expected composite cleanup failure");
    expect(closed.error).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["left-db", "right-db"],
      diagnostics: {
        failures: [
          { provider_id: "provider-left", resources: ["left-db"] },
          { provider_id: "provider-right", resources: ["right-db"] },
        ],
      },
    });
    expect(closed.error).toBeInstanceOf(ProviderCleanupError);
    expect(closed.error.diagnostics).toMatchObject({
      failures: [
        {
          diagnostics: { reason: "provider-left cleanup is unresolved" },
        },
        {
          diagnostics: { reason: "provider-right cleanup is unresolved" },
        },
      ],
    });
  }

  expect(left.close).toHaveBeenCalledTimes(2);
  expect(right.close).toHaveBeenCalledTimes(2);
});

it("preserves one child's typed cleanup error unchanged", async () => {
  const child = failingProvider("provider-only", "address_name", "one-db");
  const client = new CompositeProvider([child.provider]).createClient(
    executableTarget,
  );
  expect((await client.execute("address_name", {})).ok).toBe(true);

  const closed = await client.close();

  expect(closed.ok).toBe(false);
  if (closed.ok) throw new Error("Expected child cleanup failure");
  expect(closed.error).toBe(child.cleanupError);
});
