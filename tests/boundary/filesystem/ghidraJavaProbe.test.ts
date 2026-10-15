import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  inspectGhidraInstallation,
  ghidraInstallationDiagnostics,
} from "../../../src/ghidra/GhidraInstallation.js";
import { SUPPORTED_GHIDRA_VERSION } from "../../../src/ghidra/GhidraInstallationPolicy.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: mockSpawnSync,
}));

afterEach(() => mockSpawnSync.mockReset());

it.each([
  { major: 17, fullJdk: true, vmName: "Java HotSpot(TM) 64-Bit Server VM" },
  { major: 21, fullJdk: true, vmName: "Eclipse OpenJ9 VM" },
  { major: 21, fullJdk: false, vmName: undefined },
])(
  "preserves the reported Unicode Java home and classifies JDK $major (full JDK: $fullJdk)",
  async ({ major, fullJdk, vmName }) => {
    const root = await createTestTempDirectory("rea-java-probe-");
    const configuredHome = join(root, "selected-jdk");
    const reportedHome = join(root, "Réa逆向", `JDK ${String(major)}`);
    const installDir = join(root, "ghidra");
    await mkdir(join(installDir, "Ghidra"), { recursive: true });
    await writeFile(
      join(installDir, "Ghidra", "application.properties"),
      `application.version=${SUPPORTED_GHIDRA_VERSION}\napplication.java.min=17\n`,
    );
    if (fullJdk) {
      await mkdir(join(reportedHome, "bin"), { recursive: true });
      await writeFile(
        join(
          reportedHome,
          "bin",
          process.platform === "win32" ? "javac.exe" : "javac",
        ),
        "compiler presence fixture",
        { mode: 0o755 },
      );
    }
    const version = `${String(major)}.0.11`;
    mockSpawnSync.mockReturnValue({
      stdout: "",
      stderr: `    java.version = ${version}\n    java.home = ${reportedHome}\n    sun.arch.data.model = 64\n${vmName === undefined ? "" : `    java.vm.name = ${vmName}\n`}`,
      status: 0,
    });

    const inspection = inspectGhidraInstallation({
      environment: {},
      installDir,
      javaHome: configuredHome,
    });

    expect(inspection.javaHome).toBe(reportedHome);
    expect(inspection.javaVersion).toBe(version);
    expect(inspection.javaVmName).toBe(vmName);
    expect(ghidraInstallationDiagnostics(inspection).java_vm_name).toBe(
      vmName ?? null,
    );
    expect(inspection.checks.find(({ name }) => name === "java")).toMatchObject(
      {
        status: fullJdk ? "passed" : "failed",
        detail: expect.stringContaining(fullJdk ? "; JDK;" : "; runtime only;"),
      },
    );
    expect(mockSpawnSync).toHaveBeenCalledExactlyOnceWith(
      join(
        configuredHome,
        "bin",
        process.platform === "win32" ? "java.exe" : "java",
      ),
      expect.arrayContaining([
        "-Dstdout.encoding=UTF-8",
        "-Dstderr.encoding=UTF-8",
        "-Dsun.stdout.encoding=UTF-8",
        "-Dsun.stderr.encoding=UTF-8",
      ]),
      expect.objectContaining({ encoding: "utf8" }),
    );
  },
);

it.each([
  { label: "omitted", property: "", shown: "bitness unknown" },
  {
    label: "empty",
    property: "sun.arch.data.model =\n",
    shown: 'bitness unknown (sun.arch.data.model = "")',
  },
  {
    label: "malformed",
    property: "sun.arch.data.model = 64junk\n",
    shown: 'bitness unknown (sun.arch.data.model = "64junk")',
  },
  {
    label: "not exactly representable",
    property: "sun.arch.data.model = 9007199254740993\n",
    shown: 'bitness unknown (sun.arch.data.model = "9007199254740993")',
  },
])("keeps $label Java bitness unresolved", async ({ property, shown }) => {
  const root = await createTestTempDirectory("rea-java-bitness-");
  const configuredHome = join(root, "selected-jdk");
  const reportedHome = join(root, "reported-jdk");
  const installDir = join(root, "ghidra");
  await mkdir(join(installDir, "Ghidra"), { recursive: true });
  await mkdir(join(reportedHome, "bin"), { recursive: true });
  await writeFile(
    join(
      reportedHome,
      "bin",
      process.platform === "win32" ? "javac.exe" : "javac",
    ),
    "fixture",
    {
      mode: 0o755,
    },
  );
  await writeFile(
    join(installDir, "Ghidra", "application.properties"),
    `application.version=${SUPPORTED_GHIDRA_VERSION}\napplication.java.min=17\n`,
  );
  mockSpawnSync.mockReturnValue({
    stdout: "",
    stderr: `    java.version = 21.0.11\n    java.home = ${reportedHome}\n${property}`,
    status: 0,
  });

  const inspection = inspectGhidraInstallation({
    environment: {},
    installDir,
    javaHome: configuredHome,
  });

  expect(inspection.status).toBe("unavailable");
  expect(inspection.checks.find(({ name }) => name === "java")).toMatchObject({
    status: "failed",
    code: "version_unresolved",
    detail: expect.stringContaining(shown),
  });
  expect(
    inspection.checks.find(({ name }) => name === "java")?.detail,
  ).not.toMatch(/(?:0-bit|9007199254740992-bit)/);
});

it("keeps a known 32-bit Java report classified as unsupported", async () => {
  const root = await createTestTempDirectory("rea-java-bitness-known-");
  const configuredHome = join(root, "selected-jdk");
  const reportedHome = join(root, "reported-jdk");
  const installDir = join(root, "ghidra");
  await mkdir(join(installDir, "Ghidra"), { recursive: true });
  await mkdir(join(reportedHome, "bin"), { recursive: true });
  await writeFile(
    join(
      reportedHome,
      "bin",
      process.platform === "win32" ? "javac.exe" : "javac",
    ),
    "fixture",
    {
      mode: 0o755,
    },
  );
  await writeFile(
    join(installDir, "Ghidra", "application.properties"),
    `application.version=${SUPPORTED_GHIDRA_VERSION}\napplication.java.min=17\n`,
  );
  mockSpawnSync.mockReturnValue({
    stdout: "",
    stderr: `    java.version = 21.0.11\n    java.home = ${reportedHome}\n    sun.arch.data.model = 32\n`,
    status: 0,
  });

  const inspection = inspectGhidraInstallation({
    environment: {},
    installDir,
    javaHome: configuredHome,
  });

  expect(inspection.checks.find(({ name }) => name === "java")).toMatchObject({
    status: "failed",
    code: "unsupported_version",
    detail: expect.stringContaining("32-bit"),
  });
});

it("bounds the Java version probe and reports an over-budget probe as a failed Java check", async () => {
  const root = await createTestTempDirectory("rea-java-probe-bound-");
  const configuredHome = join(root, "selected-jdk");
  const installDir = join(root, "ghidra");
  await mkdir(join(installDir, "Ghidra"), { recursive: true });
  await writeFile(
    join(installDir, "Ghidra", "application.properties"),
    `application.version=${SUPPORTED_GHIDRA_VERSION}\napplication.java.min=17\n`,
  );
  // A chatty or hostile JVM that overruns the capture budget: spawnSync reports
  // ENOBUFS, which the probe already treats as a failed observation.
  mockSpawnSync.mockReturnValue({
    stdout: "",
    stderr: "java.version = 21.0.11\n",
    status: null,
    error: Object.assign(new Error("spawnSync /java ENOBUFS"), {
      code: "ENOBUFS",
    }),
  });

  const inspection = inspectGhidraInstallation({
    environment: {},
    installDir,
    javaHome: configuredHome,
  });

  const [, , options] = mockSpawnSync.mock.calls[0] as [
    string,
    readonly string[],
    { readonly maxBuffer?: number },
  ];
  expect(options.maxBuffer).toBe(1024 * 1024);
  expect(inspection.javaVersion).toBeNull();
  expect(inspection.javaHome).toBe(configuredHome);
  expect(inspection.checks.find(({ name }) => name === "java")).toMatchObject({
    status: "failed",
    code: "runtime_missing",
  });
});
