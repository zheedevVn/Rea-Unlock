import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { applicationVersionComparisonResultSchema } from "../../../src/domain/javascript/javascriptApplicationVersionComparisonSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "pairs repeated factory bodies by identity when application versions retain a shared bundle",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-version-matching-");
    const factoryCount = 32;
    const factories = Array.from(
      { length: factoryCount },
      (_, index) => `${index}: function() {}`,
    ).join(",");
    const bundle = `globalThis.webpackChunkApp.push([[1], {${factories}}]);`;
    const versions = await Promise.all(
      [1, 2].map(async (version) => {
        const application = join(root, String(version));
        await mkdir(application);
        await writeFile(
          join(application, "package.json"),
          JSON.stringify({ name: "shared-bundle", version: `${version}.0.0` }),
        );
        await writeFile(join(application, "chunk.js"), bundle);
        const response = await cli.run({
          arguments: ["analyze-javascript-application", application, "--json"],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(response.exitCode, response.stderr).toBe(0);
        return parseEvidence(response.json);
      }),
    );
    const [left, right] = versions;
    if (left === undefined || right === undefined)
      throw new Error("Missing application version Evidence");
    const analyses = versions.map(({ normalized_result }) =>
      javascriptApplicationAnalysisResultSchema.parse(normalized_result),
    );
    const factoryNodes = analyses.map(({ graph }) => {
      expect(graph.coverage.status).toBe("complete");
      const nodes = graph.nodes.filter(
        ({ kind, observations }) =>
          kind === "javascript-module" &&
          observations.some(
            ({ properties }) => properties.module_key !== undefined,
          ),
      );
      expect(nodes).toHaveLength(factoryCount);
      const sourceDigests = nodes.flatMap(({ observations }) =>
        observations.map(({ properties }) => properties.source_sha256),
      );
      expect(sourceDigests.every((digest) => typeof digest === "string")).toBe(
        true,
      );
      expect(new Set(sourceDigests).size).toBe(1);
      return nodes;
    });
    const inputPath = join(root, "comparison.json");
    await writeFile(inputPath, JSON.stringify({ left, right }));
    const response = await cli.run({
      arguments: ["compare-application-versions", inputPath, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const result = applicationVersionComparisonResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );

    expect(result.left.root_artifact_sha256).not.toBe(
      result.right.root_artifact_sha256,
    );
    expect(result.matching.ambiguous).toBe(0);
    expect(result.coverage.status).toBe("complete-within-inputs");
    expect(factoryNodes[0]?.map(({ node_id }) => node_id)).toEqual(
      factoryNodes[1]?.map(({ node_id }) => node_id),
    );
    for (const node of factoryNodes[0] ?? []) {
      expect(
        result.items.find(({ left_node_id }) => left_node_id === node.node_id),
      ).toMatchObject({
        status: "unchanged",
        right_node_id: node.node_id,
        match: {
          status: "matched",
          basis: "exact-node-identity",
          candidate_left_node_ids: [],
          candidate_right_node_ids: [],
        },
      });
    }
  },
);

cliTest(
  "matches an unchanged source module after a sibling file changes",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-source-module-version-");
    const versions = await Promise.all(
      ["left", "right"].map(async (name) => {
        const application = join(root, name);
        await mkdir(join(application, "src"), { recursive: true });
        await writeFile(
          join(application, "package.json"),
          JSON.stringify({
            name: "source-module-fixture",
            version: "1.0.0",
            main: "src/main.js",
          }),
        );
        await writeFile(
          join(application, "src/main.js"),
          'require("./util.js");\n',
        );
        await writeFile(
          join(application, "src/util.js"),
          `module.exports = ${JSON.stringify(name)};\n`,
        );
        const response = await cli.run({
          arguments: ["analyze-javascript-application", application, "--json"],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(response.exitCode, response.stderr).toBe(0);
        return parseEvidence(response.json);
      }),
    );
    const [left, right] = versions;
    if (left === undefined || right === undefined)
      throw new Error("Missing source module Evidence");
    const analyses = versions.map(({ normalized_result }) =>
      javascriptApplicationAnalysisResultSchema.parse(normalized_result),
    );
    const sourceModules = analyses.map(({ graph }) => {
      const node = graph.nodes.find(
        ({ kind, observations }) =>
          kind === "javascript-module" &&
          observations.some(
            ({ properties }) =>
              properties.semantic_role === "source-module" &&
              properties.path === "src/main.js",
          ),
      );
      if (node === undefined) throw new Error("Missing main source module");
      expect(
        node.observations.some(
          ({ properties }) => typeof properties.source_sha256 === "string",
        ),
      ).toBe(true);
      return node;
    });
    const inputPath = join(root, "comparison.json");
    await writeFile(inputPath, JSON.stringify({ left, right }));
    const response = await cli.run({
      arguments: ["compare-application-versions", inputPath, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const result = applicationVersionComparisonResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );

    expect(result.items).toContainEqual(
      expect.objectContaining({
        left_node_id: sourceModules[0]?.node_id,
        right_node_id: sourceModules[1]?.node_id,
        status: "unchanged",
        match: expect.objectContaining({
          status: "matched",
          basis: "exact-module-source-digest",
          confidence: "exact",
        }),
      }),
    );
  },
);
