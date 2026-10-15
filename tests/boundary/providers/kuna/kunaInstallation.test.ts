import { createHash } from "node:crypto";
import { chmod, readFile, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

import { expect, it as test } from "vitest";

import { readKunaConfiguration } from "../../../../src/kuna/KunaConfiguration.js";
import { inspectKunaInstallation } from "../../../../src/kuna/KunaInstallation.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { fakeKunaCalls, writeFakeKuna } from "./fakeKuna.js";

const it = test.skipIf(process.platform === "win32");

it("identifies a caller-selected kuna by version and digest", async () => {
  const root = await createTestTempDirectory("rea-kuna-install-");
  const kuna = await writeFakeKuna(root);
  const link = join(root, "current-kuna");
  await symlink(kuna, link);

  const result = await inspectKunaInstallation({
    REA_KUNA_COMMAND: link,
    REA_KUNA_CACHE_DIR: join(root, "cache"),
  });

  expect(result).toMatchObject({
    ok: true,
    value: {
      configuration: { command: link, cacheRoot: join(root, "cache") },
      executable: await realpath(kuna),
      version: "1.833",
      verified: true,
      // A `#!` launcher reports its interpreter; ownership checks must not expect the path.
      script: true,
      sha256: createHash("sha256")
        .update(await readFile(kuna))
        .digest("hex"),
    },
  });
  // The probe runs inside REA's cache home with no inherited PATH.
  expect(await fakeKunaCalls(kuna)).toEqual([
    {
      pid: expect.any(Number),
      argv: ["--version"],
      home: join(root, "cache", "home"),
      xdg: join(root, "cache", "home", ".cache"),
      path: null,
    },
  ]);
});

it("accepts another release but reports it as unverified", async () => {
  const root = await createTestTempDirectory("rea-kuna-unverified-");
  const kuna = await writeFakeKuna(root, {
    version: { stdout: "kuna 1.900\n" },
  });

  const result = await inspectKunaInstallation({ REA_KUNA_COMMAND: kuna });

  expect(result).toMatchObject({
    ok: true,
    value: { version: "1.900", verified: false },
  });
});

it("refuses a version line it cannot recognize", async () => {
  const root = await createTestTempDirectory("rea-kuna-garbled-");
  const kuna = await writeFakeKuna(root, {
    version: { stdout: "Kuna decompiler, built today\n" },
  });

  expect(
    await inspectKunaInstallation({ REA_KUNA_COMMAND: kuna }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "version_unresolved",
      diagnostics: { stdout: "Kuna decompiler, built today\n" },
    },
  });
});

it("reports a failed version probe with its exit status", async () => {
  const root = await createTestTempDirectory("rea-kuna-probe-exit-");
  const kuna = await writeFakeKuna(root, { version: { exit: 3 } });

  expect(
    await inspectKunaInstallation({ REA_KUNA_COMMAND: kuna }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "version_unresolved",
      reason: expect.stringContaining("version probe failed"),
      diagnostics: { exit_code: 3, killed: false },
    },
  });
});

it("reports a missing or non-executable command as executable_missing", async () => {
  const root = await createTestTempDirectory("rea-kuna-missing-");
  const kuna = await writeFakeKuna(root);
  await chmod(kuna, 0o644);

  for (const command of [kuna, join(root, "absent"), root])
    expect(
      await inspectKunaInstallation({ REA_KUNA_COMMAND: command }),
    ).toMatchObject({
      ok: false,
      error: { code: "executable_missing", diagnostics: { command } },
    });
});

it("distinguishes an unset command from an invalid one", async () => {
  expect(await inspectKunaInstallation({})).toMatchObject({
    ok: false,
    error: { code: "not_configured", diagnostics: { configured: false } },
  });
  expect(
    await inspectKunaInstallation({ REA_KUNA_COMMAND: "bin/kuna" }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "open_options_invalid",
      diagnostics: { configured: true, setting: "REA_KUNA_COMMAND" },
    },
  });
});

it("declares Windows hosts unsupported before touching the command", async () => {
  expect(
    await inspectKunaInstallation(
      { REA_KUNA_COMMAND: "/opt/kuna/kuna" },
      { platform: "win32" },
    ),
  ).toMatchObject({ ok: false, error: { code: "unsupported_host" } });
});

it("parses cache, timeout and job settings at the configuration boundary", () => {
  const environment = {
    REA_KUNA_COMMAND: "/opt/kuna/kuna",
    HOME: "/home/analyst",
  };
  expect(readKunaConfiguration(environment, "linux")).toMatchObject({
    ok: true,
    value: {
      cacheRoot: "/home/analyst/.cache/rea/kuna",
      cacheMaxBytes: 4 * 1024 ** 3,
      projectTimeoutMs: 1_800_000,
      // Kuna's reference answer is a serial export; more jobs change results.
      jobs: 1,
    },
  });
  expect(
    readKunaConfiguration(
      { ...environment, XDG_CACHE_HOME: "/var/cache/analyst" },
      "linux",
    ),
  ).toMatchObject({ value: { cacheRoot: "/var/cache/analyst/rea/kuna" } });
  expect(readKunaConfiguration(environment, "darwin")).toMatchObject({
    value: { cacheRoot: "/home/analyst/Library/Caches/rea/kuna" },
  });
  expect(
    readKunaConfiguration(
      {
        ...environment,
        REA_KUNA_CACHE_MAX_BYTES: "2097152",
        REA_KUNA_PROJECT_TIMEOUT_MS: "60000",
        REA_KUNA_JOBS: "3",
      },
      "linux",
    ),
  ).toMatchObject({
    value: { cacheMaxBytes: 2097152, projectTimeoutMs: 60000, jobs: 3 },
  });
  for (const [setting, value] of [
    ["REA_KUNA_CACHE_DIR", "relative/cache"],
    ["REA_KUNA_CACHE_MAX_BYTES", "1024"],
    ["REA_KUNA_CACHE_MAX_BYTES", "4GiB"],
    ["REA_KUNA_PROJECT_TIMEOUT_MS", "0"],
    ["REA_KUNA_JOBS", "33"],
    ["REA_KUNA_JOBS", "0"],
  ] as const)
    expect(
      readKunaConfiguration({ ...environment, [setting]: value }, "linux"),
    ).toMatchObject({
      ok: false,
      error: { code: "open_options_invalid", setting },
    });
});

it("stops a version probe that ignores SIGTERM instead of waiting on it", async () => {
  const root = await createTestTempDirectory("rea-kuna-probe-term-");
  const kuna = await writeFakeKuna(root, { version: { ignoreTerm: true } });
  const started = Date.now();

  const result = await inspectKunaInstallation(
    { REA_KUNA_COMMAND: kuna },
    // Long enough for Node to start the fake and install its SIGTERM handler.
    { probeTimeoutMs: 1500 },
  );

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "version_unresolved",
      diagnostics: { killed: true, deadline_ms: 1500 },
    },
  });
  // The deadline plus ExecFileOutput's bounded kill grace, never an open-ended wait.
  expect(Date.now() - started).toBeLessThan(15_000);
  const pid = (await fakeKunaCalls(kuna))[0]?.pid ?? 0;
  expect(() => process.kill(pid, 0)).toThrow();
}, 20_000);
