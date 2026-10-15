import { setTimeout as delay } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import { runPcapCommand } from "../../../src/pcap/PcapCommand.js";
import * as ownership from "../../../src/process/ProcessOwnershipObservation.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import type { ProviderProcessSupervisor } from "../../../src/process/ProviderProcess.js";

it("does not spend the tool execution deadline preparing native ownership", async () => {
  const original = ownership.prepareProcessOwnershipInspection;
  let entered!: () => void;
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const prepare = vi
    .spyOn(ownership, "prepareProcessOwnershipInspection")
    .mockImplementation(async (signal) => {
      await original(signal);
      if (first) {
        first = false;
        entered();
        await gate;
      }
    });
  onTestFinished(() => {
    prepare.mockRestore();
    release();
  });
  const pending = runPcapCommand({
    operation: "inspect_pcap_client",
    command: process.execPath,
    arguments: ["--version"],
    limits: { timeoutMs: 1000, maxOutputBytes: 1024 },
    environment: {},
    signal: undefined,
    retain: (owner) => {
      onTestFinished(async () => {
        expect((await owner.stop()).status).not.toBe("incomplete");
      });
    },
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await preparing;
  await delay(1100);
  release();
  const result = await pending;
  if (!result.ok) throw result.error;
  expect(result.value.stdout.trim()).toBe(process.version);
});

it("returns complete stdout while retaining unresolved process cleanup", async () => {
  let retained:
    | {
        readonly resources: readonly string[];
        readonly reason: string;
        readonly owner: ProviderProcessSupervisor;
      }
    | undefined;
  let mayClean = false;
  const output = await runPcapCommand({
    operation: "inspect_pcap_capture",
    command: process.execPath,
    arguments: ["-e", 'process.stdout.write("complete producer output")'],
    limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
    environment: {},
    signal: undefined,
    launcher: async (spawn) => {
      const launched = await spawnOwnedProviderProcess(spawn);
      const cleanup =
        launched.cleanup ??
        (() => cleanupOwnedProcessGroup(launched.ownership));
      return {
        ...launched,
        cleanup: async () => {
          const stopped = await cleanup();
          if (!mayClean) throw new Error("injected cleanup uncertainty");
          return stopped;
        },
      };
    },
    retain: (owner, resources, reason) => {
      retained = { owner, resources, reason };
    },
  });
  expect(output.stdout).toBe("complete producer output");
  expect(output.cleanup).toMatchObject({
    reason: "injected cleanup uncertainty",
    capturedOutput: {
      stdout: "complete producer output",
      stderr: "",
      truncated: false,
    },
  });
  expect(retained?.resources).toContain(
    `process-group:${retained?.owner.launch.ownership?.processGroupId}`,
  );
  expect(retained?.reason).toBe("injected cleanup uncertainty");
  if (retained === undefined) throw new Error("Cleanup owner was not retained");
  mayClean = true;
  expect((await retained.owner.stop()).status).not.toBe("incomplete");
});
