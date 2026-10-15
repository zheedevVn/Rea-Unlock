import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it as test } from "vitest";

import { inspectKunaProvider } from "../../../../src/kuna/KunaDoctor.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { writeFakeKuna } from "./fakeKuna.js";

const it = test.skipIf(process.platform === "win32");

it("reports an unconfigured Kuna as a missing optional engine", async () => {
  expect(await inspectKunaProvider({})).toMatchObject({
    id: "kuna",
    configured: false,
    available: false,
    providerVersion: null,
    registrationEnvironment: {},
    checks: [
      {
        name: "installation",
        ok: false,
        code: "not_configured",
        classification: "missing_analysis_engine",
      },
    ],
  });
});

it("publishes the caller's explicit settings once the installation validates", async () => {
  const root = await createTestTempDirectory("rea-kuna-doctor-");
  const kuna = await writeFakeKuna(root);
  const cache = join(root, "cache");

  const inspection = await inspectKunaProvider({
    REA_KUNA_COMMAND: kuna,
    REA_KUNA_CACHE_DIR: cache,
    REA_KUNA_JOBS: "4",
    UNRELATED: "not published",
  });

  expect(inspection).toMatchObject({
    configured: true,
    available: true,
    providerVersion: "1.833",
    registrationEnvironment: {
      REA_KUNA_COMMAND: kuna,
      REA_KUNA_CACHE_DIR: cache,
      REA_KUNA_JOBS: "4",
    },
    checks: [
      { name: "installation", ok: true, details: { version: "1.833" } },
      {
        name: "cache",
        ok: true,
        detail: `REA creates the Kuna project cache at ${cache} on first use.`,
      },
    ],
  });
  expect(Object.keys(inspection.registrationEnvironment)).toHaveLength(3);
});

it("flags an unverified release without failing the installation", async () => {
  const root = await createTestTempDirectory("rea-kuna-doctor-version-");
  const kuna = await writeFakeKuna(root, {
    version: { stdout: "kuna 1.950\n" },
  });

  const inspection = await inspectKunaProvider({ REA_KUNA_COMMAND: kuna });

  expect(inspection.checks[0]).toMatchObject({
    ok: true,
    detail: expect.stringContaining(
      "this release's project layout is unverified",
    ),
  });
});

it("reports a cache root REA cannot use without creating anything", async () => {
  const root = await createTestTempDirectory("rea-kuna-doctor-cache-");
  const kuna = await writeFakeKuna(root);
  const occupied = join(root, "occupied");
  await writeFile(occupied, "not a directory");
  const existing = join(root, "existing");
  await mkdir(existing);

  const blocked = await inspectKunaProvider({
    REA_KUNA_COMMAND: kuna,
    REA_KUNA_CACHE_DIR: occupied,
  });
  const ready = await inspectKunaProvider({
    REA_KUNA_COMMAND: kuna,
    REA_KUNA_CACHE_DIR: existing,
  });

  expect(blocked.checks[1]).toMatchObject({
    name: "cache",
    ok: false,
    code: "open_options_invalid",
  });
  expect(ready.checks[1]).toMatchObject({
    name: "cache",
    ok: true,
    detail: expect.stringContaining(`cached in ${existing}`),
  });
});

it("reports a cache root REA cannot create under its nearest existing parent", async () => {
  const root = await createTestTempDirectory("rea-kuna-doctor-create-");
  const kuna = await writeFakeKuna(root);
  const readOnly = join(root, "read-only");
  await mkdir(readOnly, { mode: 0o500 });
  const occupied = join(root, "occupied");
  await writeFile(occupied, "not a directory");

  const underReadOnly = await inspectKunaProvider({
    REA_KUNA_COMMAND: kuna,
    REA_KUNA_CACHE_DIR: join(readOnly, "nested", "cache"),
  });
  const underFile = await inspectKunaProvider({
    REA_KUNA_COMMAND: kuna,
    REA_KUNA_CACHE_DIR: join(occupied, "cache"),
  });

  expect(underReadOnly.checks[1]).toMatchObject({
    name: "cache",
    ok: false,
    detail: expect.stringContaining(`${readOnly} is not writable`),
  });
  expect(underFile.checks[1]).toMatchObject({
    name: "cache",
    ok: false,
    // stat reports ENOTDIR for a path beneath a regular file.
    detail: expect.stringContaining("not a directory"),
  });
});
