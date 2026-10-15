import { chmod, lstat, readFile, unlink } from "node:fs/promises";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  expectConfigurationRefusal,
  serveCli as serve,
} from "./cliServeHarness.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

it.each([
  [
    ["inspect-adb-client", "--json"],
    "/nonexistent/adb",
    "The selected adb binary was not found: /nonexistent/adb. Set REA_ADB_PATH",
  ],
  [
    ["list-adb-devices", "--json"],
    "/nonexistent/adb",
    "The selected adb binary was not found: /nonexistent/adb. Set REA_ADB_PATH",
  ],
  [
    ["list-adb-devices", "--json"],
    "relative/adb",
    "REA_ADB_PATH must be an absolute path to the adb binary.",
  ],
])(
  "%j with REA_ADB_PATH=%s names the host requirement",
  async (argv, binary, reason) => {
    const result = await serve(argv, { REA_ADB_PATH: binary });
    expectConfigurationRefusal(result, reason);
  },
);

it("validates device serials before contacting any device", async () => {
  const result = await serve(["inspect-adb-device", "bad serial", "--json"]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
  });
});

it.each(["string:key", ":", "string"])(
  "classifies malformed activity extra %j before contacting adb",
  async (extra) => {
    const result = await serve(
      [
        "start-adb-activity",
        "emulator-5554",
        "android.intent.action.VIEW",
        "--extra",
        extra,
        "--format",
        "json",
      ],
      { REA_ADB_PATH: "/path/that/does/not/exist" },
    );

    const error = JSON.parse(result.stdout);
    expect(error).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: true,
      remediation: { action: expect.any(String) },
    });
    expect(error.remediation.action).not.toBe("");
    expect(error.message).not.toBe("");
  },
);

it.each([
  ["bogus:key:value", "invalid_request"],
  ["string:key:value", "capability_unavailable"],
] as const)(
  "preserves downstream validation for well-delimited activity extra %j",
  async (extra, code) => {
    const result = await serve(
      [
        "start-adb-activity",
        "emulator-5554",
        "android.intent.action.VIEW",
        "--extra",
        extra,
        "--format",
        "json",
      ],
      { REA_ADB_PATH: "/path/that/does/not/exist" },
    );

    expect(JSON.parse(result.stdout)).toMatchObject({ code });
  },
);

it.skipIf(process.platform === "win32")(
  "preserves requested reinstall mode without claiming prior package state",
  async () => {
    const workspace = await createTestWorkspace("rea-adb-install-state-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const apk = await workspace.write("app.apk", "apk");
    const adb = await workspace.write(
      "adb",
      `#!/bin/sh
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s\\n' "$*" >> "$root/calls"
if [ "$1" = version ]; then
  printf 'Android Debug Bridge version 1.0.41\\nVersion 34.0.5-cli\\nInstalled as %s\\n' "$0"
  exit 0
fi
if [ "$1" = -s ] && [ "$3" = install ]; then
  if [ -f "$root/installed" ]; then
    if [ "$4" != -r ]; then
      printf 'Failure [INSTALL_FAILED_ALREADY_EXISTS]\\n'
      exit 0
    fi
    printf 'replacement\\n' >> "$root/events"
  else
    printf 'fresh-install\\n' >> "$root/events"
  fi
  : > "$root/installed"
  printf 'Performing Streamed Install\\nSuccess\\n'
  exit 0
fi
exit 1
`,
    );
    await chmod(adb, 0o755);

    const installEnvelope = z.object({
      ok: z.literal(true),
      data: toolContract("install_adb_package").outputSchema,
    });
    const install = async (replace: boolean) => {
      const result = await serve(
        [
          "install-adb-package",
          "emulator-5554",
          apk,
          ...(replace ? ["--replace"] : []),
          "--format",
          "json",
          "--full-output",
        ],
        { REA_ADB_PATH: adb },
      );
      expect(result.exitCode).toBe(0);
      return installEnvelope.parse(JSON.parse(result.stdout));
    };

    const freshReplace = await install(true);
    expect(freshReplace).toMatchObject({
      ok: true,
      data: {
        parameters: { replace: true },
        normalized_result: { replace_requested: true, replaced: null },
        confidence: "observed",
      },
    });
    expect(freshReplace.data.limitations.join("\n")).toContain(
      "Whether an existing package was replaced is unknown",
    );

    const existingReplace = await install(true);
    expect(existingReplace).toMatchObject({
      ok: true,
      data: {
        parameters: { replace: true },
        normalized_result: { replace_requested: true, replaced: null },
      },
    });

    await unlink(workspace.path("installed"));
    const freshDefault = await install(false);
    expect(freshDefault).toMatchObject({
      ok: true,
      data: {
        parameters: { replace: false },
        normalized_result: { replace_requested: false, replaced: null },
      },
    });
    expect(await readFile(workspace.path("events"), "utf8")).toBe(
      "fresh-install\nreplacement\nfresh-install\n",
    );
    const calls = await readFile(workspace.path("calls"), "utf8");
    expect(calls.split("\n").filter((line) => line !== "")).toEqual([
      "version",
      `-s emulator-5554 install -r ${apk}`,
      "version",
      `-s emulator-5554 install -r ${apk}`,
      "version",
      `-s emulator-5554 install ${apk}`,
    ]);
  },
);

it("requires the output directory option on pull", async () => {
  const result = await serve([
    "pull-adb-package",
    "emulator-5554",
    "com.example",
    "--json",
  ]);
  expect(result.exitCode).not.toBe(0);
});

it.skipIf(process.platform === "win32")(
  "refuses a trailing device separator through the CLI before adb or output effects",
  async () => {
    const workspace = await createTestWorkspace("rea-adb-cli-pull-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const adb = await workspace.write(
      "adb",
      `#!/bin/sh
if [ "$1" = "version" ]; then
  printf 'Android Debug Bridge version 1.0.41\\nVersion 34.0.5-cli\\nInstalled as %s\\n' "$0"
  exit 0
fi
: > '${workspace.path("invoked")}'
exit 0
`,
    );
    await chmod(adb, 0o755);
    const output = workspace.path("pulls");
    const result = await serve(
      [
        "pull-adb-file",
        "emulator-5554",
        "/data/local/tmp/",
        "--output-directory",
        output,
        "--json",
      ],
      { REA_ADB_PATH: adb },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "invalid_request",
    });
    await expect(readFile(workspace.path("invoked"))).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
