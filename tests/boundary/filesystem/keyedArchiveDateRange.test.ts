import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { expect } from "vitest";

import { keyedArchiveResultSchema } from "../../../src/domain/apple/keyedArchive.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "built CLI reports a date the decoder cannot represent as unknown",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-keyed-archive-date-");
    const path = join(root, "archive.plist");
    // plutil writes years past 9999 unsigned, which the decoder rejects.
    const xml = build({
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: ["$null", "__FAR__", new Date("2020-01-01T00:00:00Z")],
      $top: { far: { CF$UID: 1 }, near: { CF$UID: 2 } },
    }).replace(
      "<string>__FAR__</string>",
      "<date>11507-08-17T05:20:00Z</date>",
    );
    await writeFile(path, xml);
    const output = await cli.run({
      arguments: ["inspect-keyed-archive", path, "--json"],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expect(output.exitCode).toBe(0);
    const result = keyedArchiveResultSchema.parse(
      parseEvidence(output.json).normalized_result,
    );
    expect(result.objects.map(({ id, value }) => ({ id, value }))).toEqual([
      { id: 0, value: "$null" },
      { id: 1, value: { $plist_type: "date", iso8601: null } },
      {
        id: 2,
        value: { $plist_type: "date", iso8601: "2020-01-01T00:00:00.000Z" },
      },
    ]);
    expect(result.limitations).toContainEqual(
      expect.stringContaining("1 date value(s)"),
    );
  },
);
