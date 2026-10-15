import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect } from "vitest";

import { historicalSourceGraphSchema } from "../../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// Reference-source reads require no-follow opens; Windows reports unsupported.
describe.skipIf(process.platform === "win32")(
  "compiled reference-source directory imports",
  () => {
    cliTest(
      "resolves directory spellings without selecting similarly named files",
      async ({ cli }) => {
        const workspace = await createTestTempDirectory(
          "rea-reference-directory-imports-",
        );
        const root = join(workspace, "source");
        const outside = join(workspace, "outside", "index.js");
        const imports = [
          ["slash.cjs", "./lib/", "lib/index.js"],
          ["dot.cjs", "./lib/.", "lib/index.js"],
          ["self.cjs", ".", "index.js"],
          ["self-slash.cjs", "./", "index.js"],
          ["nested/parent.cjs", "..", "index.js"],
          ["nested/parent-slash.cjs", "../", "index.js"],
          ["direct.cjs", "./lib.js", "lib.js"],
          ["fallback.cjs", "./fallback", "fallback/index.js"],
          ["legacy-order.cjs", "./dep", "dep/index.js"],
          ["bare-index.cjs", "./bare", "bare.js"],
          ["package-main.cjs", "./pkg", "pkg/actual.js"],
          ["package-main-fallback.cjs", "./stale", "stale/index.js"],
          ["package-main-slash.cjs", "./slashed", "slashed/lib.js"],
        ] as const;
        const unresolved = [
          ["missing.cjs", "./missing/", "missing/"],
          ["escape.cjs", "../outside/", "../outside/"],
          ["main.ts", "./folder.js/.", "folder.js"],
          ["only-bare.cjs", "./only/", "only/"],
          ["invalid-manifest.cjs", "./broken", "broken"],
          ["absolute-main.cjs", "./absolute", outside],
        ] as const;
        const files = new Map<string, string>([
          ["index.js", 'module.exports = "root index";\n'],
          ["lib/index.js", 'module.exports = "library index";\n'],
          ["lib.js", 'module.exports = "sibling JavaScript file";\n'],
          ["lib.ts", 'export const value = "sibling TypeScript file";\n'],
          ["fallback/index.js", 'module.exports = "fallback index";\n'],
          ["dep/index.js", 'module.exports = "existing index priority";\n'],
          ["dep.cjs", 'module.exports = "later CommonJS candidate";\n'],
          [
            "folder.ts",
            'export const value = "emitted filename counterpart";\n',
          ],
          ["missing.js", 'module.exports = "not a directory";\n'],
          ["bare.js", 'module.exports = "file before directory";\n'],
          ["bare/index", 'module.exports = "extensionless index";\n'],
          ["only/index", 'module.exports = "extensionless index";\n'],
          // A package main outranks the index; a missing main falls back to it.
          ["pkg/package.json", '{"main":"actual.js"}\n'],
          ["pkg/actual.js", 'module.exports = "declared main";\n'],
          ["pkg/index.js", 'module.exports = "ignored index";\n'],
          ["stale/package.json", '{"main":"gone.js"}\n'],
          ["stale/index.js", 'module.exports = "legacy fallback";\n'],
          ["broken/package.json", '{"main":\n'],
          ["broken/index.js", 'module.exports = "unknown selection";\n'],
          // Node resolves main with path.resolve: no trailing-slash directory
          // intent, and an absolute main leaves the imported root.
          ["slashed/package.json", '{"main":"lib/"}\n'],
          ["slashed/lib.js", 'module.exports = "file main";\n'],
          ["slashed/lib/index.js", 'module.exports = "not selected";\n'],
          ["slashed/index.js", 'module.exports = "not selected";\n'],
          ["absolute/package.json", `${JSON.stringify({ main: outside })}\n`],
          ["absolute/index.js", 'module.exports = "not selected";\n'],
          ...[...imports, ...unresolved].map(
            ([path, specifier]) =>
              [path, `require(${JSON.stringify(specifier)});\n`] as const,
          ),
        ]);
        await Promise.all(
          [...files].map(async ([path, contents]) => {
            const target = join(root, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, contents);
          }),
        );
        await mkdir(dirname(outside), { recursive: true });
        await writeFile(outside, 'module.exports = "outside import root";\n');

        // Node's loader establishes each fixture's meaning independently.
        for (const [path, specifier, target] of imports)
          expect(createRequire(join(root, path)).resolve(specifier)).toBe(
            join(root, target),
          );
        expect(() =>
          createRequire(join(root, "missing.cjs")).resolve("./missing/"),
        ).toThrow();
        expect(() =>
          createRequire(join(root, "main.ts")).resolve("./folder.js/."),
        ).toThrow();
        expect(() =>
          createRequire(join(root, "only-bare.cjs")).resolve("./only/"),
        ).toThrow();
        expect(() =>
          createRequire(join(root, "invalid-manifest.cjs")).resolve("./broken"),
        ).toThrow();
        expect(
          createRequire(join(root, "escape.cjs")).resolve("../outside/"),
        ).toBe(outside);
        expect(
          createRequire(join(root, "absolute-main.cjs")).resolve("./absolute"),
        ).toBe(outside);

        const result = await cli.run({
          arguments: ["import-reference-source", root, "--json"],
          environment: {
            HOME: workspace,
            XDG_CONFIG_HOME: workspace,
            XDG_CACHE_HOME: workspace,
          },
        });
        expect(result.exitCode).toBe(0);
        const graph = historicalSourceGraphSchema.parse(result.json);
        expect(graph.parse_failures).toEqual([]);
        expect(graph.relationships).toHaveLength(
          imports.length + unresolved.length,
        );
        for (const [from, , to] of imports)
          expect.soft(graph.relationships, from).toContainEqual({
            from_path: from,
            to,
            kind: "requires",
            resolution: "internal",
            parse_state: "parsed",
          });
        for (const [from, , to] of unresolved)
          expect.soft(graph.relationships, from).toContainEqual({
            from_path: from,
            to,
            kind: "requires",
            resolution: "unresolved",
            parse_state: "parsed",
          });
        expect(
          graph.entries.some((entry) => entry.path.includes("outside")),
        ).toBe(false);
      },
    );
  },
);
