import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err } from "../domain/result.js";
import { ArtifactAnalysisResources } from "./ArtifactAnalysisResources.js";
import { readLinuxResourceLimits } from "./LinuxResourceLimits.js";
import { ProviderProcessSupervisor } from "./ProviderProcess.js";

it("projects the specific reason and member evidence for retained cleanup", async () => {
  const producer = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  const owner = new ProviderProcessSupervisor({
    process: producer,
    ownsProcessLifetime: true,
    ownership: {
      runId: "rea-tshark-run-1",
      leaderPid: 4242,
      processGroupId: 4242,
    },
    cleanup: async () => ({
      cleaned: false as const,
      reason: "process ownership token could not be read for 1 live process",
      failures: [
        {
          pid: 101,
          reason: "environment-unreadable" as const,
          diagnostic: "sysctl_errno_22",
        },
      ],
      unverified: [
        { pid: 900, diagnostic: "platform_binary_environment_withheld" },
      ],
    }),
  });
  const resources = new ArtifactAnalysisResources(
    "fixture-provider",
    "fixture-operation",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  resources.retain({ path: "runtime-root", close: async () => {} }, owner);

  const result = await resources.finish(
    err(new ProviderAdapterError("fixture-provider", "fixture-operation")),
    () => {
      throw new Error("unexpected success observation");
    },
  );
  owner.dispose();

  if (result.ok) throw new Error("expected cleanup failure");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      resources: [
        "rea-tshark-run-1",
        "runtime-root",
        "pid:4242",
        "process-group:4242",
      ],
      diagnostics: {
        reason: "process ownership token could not be read for 1 live process",
        failures: [
          {
            pid: 101,
            reason: "environment-unreadable",
            diagnostic: "sysctl_errno_22",
          },
        ],
        unverified: [
          { pid: 900, diagnostic: "platform_binary_environment_withheld" },
        ],
      },
    },
  });
});
