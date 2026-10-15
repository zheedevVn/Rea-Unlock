import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  analyzeJavaScriptDirectory,
  runNodeJsonControl,
} from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains only final known RPC object properties through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-rpc-properties-");
    await writeFixtureFiles(root, {
      "entry.mjs": `
        function httpBatchLink(options) { return options.url; }
        const options = { url: "/trpc/runtime" };
        const key = "url";
        const links = [
          httpBatchLink({ url: "/trpc/old", url: "/trpc/live" }),
          httpBatchLink({ url: "/trpc/spread-old", ...options }),
          httpBatchLink({ url: "/trpc/computed-old", [key]: options.url }),
          httpBatchLink({ ...options, url: "/trpc/final", headers: {} }),
        ];
        const doc = {
          kind: "OperationDefinition", operation: "query", operation: "mutation",
          name: { kind: "Name", value: "Old" },
          name: { kind: "Name", value: "Current" },
        };
        console.log(JSON.stringify([links, doc.operation, doc.name.value]));
      `,
    });
    // This control checks JavaScript object semantics, not a live tRPC client.
    expect(await runNodeJsonControl(root, "entry.mjs")).toEqual([
      ["/trpc/live", "/trpc/runtime", "/trpc/runtime", "/trpc/final"],
      "mutation",
      "Current",
    ]);
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const endpoints = graph.nodes
      .filter((node) => node.kind === "endpoint")
      .flatMap((node) => node.observations)
      .filter(({ properties }) =>
        /^(trpc:link:|graphql:)/u.test(String(properties.mechanism)),
      )
      .map(({ properties }) => [properties.value, properties.mechanism]);
    expect(endpoints).toEqual(
      expect.arrayContaining([
        ["/trpc/live", "trpc:link:httpBatchLink"],
        ["/trpc/final", "trpc:link:httpBatchLink"],
        ["Current", "graphql:mutation"],
      ]),
    );
    expect(endpoints).toHaveLength(3);
  },
);
