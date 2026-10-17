import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";

import { runKunaCommand } from "../../dist/kuna/KunaCommand.js";
import { inspectKunaInstallation } from "../../dist/kuna/KunaInstallation.js";
import { KUNA_XREF_OUTPUT_BYTES } from "../../dist/kuna/KunaReferenceFiles.js";

/** Independent projection of native exact-target rows, bypassing REA's parser. */
export const nativeKunaIncomingSites = async ({
  executable,
  cacheRoot,
  workspace,
  binary,
  address,
  retain,
  fileCloseResources,
}) => {
  const installed = await inspectKunaInstallation(
    {
      REA_KUNA_COMMAND: executable,
      REA_KUNA_CACHE_DIR: cacheRoot,
    },
    { fileCloseResources },
  );
  assert.ok(installed.ok, "Native reference oracle could not inspect Kuna");
  const input = await realpath(binary);
  const timeoutMs = installed.value.configuration.functionTimeoutMs;
  const outcome = await runKunaCommand({
    installation: installed.value,
    arguments: ["xrefs", input, "--to", address, "--json"],
    workspace,
    operation: "verify:kuna-native-xrefs",
    timeoutMs,
    reportedTimeoutMs: timeoutMs,
    outputBytes: KUNA_XREF_OUTPUT_BYTES,
    signal: new AbortController().signal,
    retainFailedFileClose: (owner, resource) =>
      fileCloseResources.retain(owner, resource),
  });
  if (outcome.kind === "retained") retain(outcome);
  if (outcome.kind !== "ok") throw outcome.error;
  const document = JSON.parse(outcome.snapshot.stdout.text);
  assert.equal(document.binary, input);
  assert.equal(document.direction, "to");
  assert.equal(document.target.address_hex, address);
  assert.equal(document.count, document.xrefs.length);
  const sites = document.xrefs
    .filter((row) => row.to_address_hex === address)
    .map((row) => row.from_address_hex);
  assert.ok(sites.every((site) => /^0x[0-9a-f]+$/u.test(site)));
  return [...new Set(sites)].sort();
};
