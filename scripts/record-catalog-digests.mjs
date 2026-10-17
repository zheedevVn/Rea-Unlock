import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Record the default catalog digests into the compiled runtime. Run after
// `tsc` and before bundling, so the digests come from the same compiled
// contracts and pinned schema converter that the runtime serves.
const compiledRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
const { createCatalogDigests } = await import(
  pathToFileURL(join(compiledRoot, "catalogIdentity.js")).href
);
await writeFile(
  join(compiledRoot, "recordedCatalogDigests.js"),
  `/** Recorded from the compiled default catalog by scripts/record-catalog-digests.mjs; do not edit. */\nexport const RECORDED_CATALOG_DIGESTS = Object.freeze(${JSON.stringify(createCatalogDigests())});\n`,
  "utf8",
);
