import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { PROMPT_CONTRACTS } from "./contracts/promptContracts.js";
import type { PromptContract } from "./contracts/promptContracts.js";
import { TOOL_CONTRACTS } from "./contracts/toolContracts.js";
import type { ToolContract } from "./contracts/toolContractTypes.js";
import { CLI_COMMAND_NAMES } from "./cliCommandNames.js";
import { compareUnicodeCodePoints } from "./domain/unicodeCodePointOrder.js";
import {
  advertisedInputJsonSchema,
  toolOutputSchemaWithMetadata,
} from "./contracts/toolSchemaMetadata.js";
import {
  presentAdvertisedInputSchema,
  type CompactInputSchemaPresentation,
} from "./contracts/compactInputSchema.js";
import type { McpOutputSchemaProfile } from "./config/mcpOutputSchemaProfile.js";
import { RECORDED_CATALOG_DIGESTS } from "./recordedCatalogDigests.js";

const sortByName = (
  contracts: readonly ToolContract[],
): readonly ToolContract[] =>
  [...contracts].sort((left, right) =>
    compareUnicodeCodePoints(left.name, right.name),
  );

const sortedToolContracts = sortByName(TOOL_CONTRACTS);

/**
 * Digested per-tool projection. Every contract field that changes what a
 * client receives belongs here, including `returns_target_content`: a server
 * that predates the untrusted-content framing must not digest equal to one
 * that emits `_meta.provenance`, or a stale process would report aligned.
 */
const createToolCatalog = (
  contracts: readonly ToolContract[],
  compactPresentation: CompactInputSchemaPresentation | undefined,
) =>
  contracts.map((contract) => ({
    name: contract.name,
    title: contract.title,
    surface: contract.kind,
    description: contract.description,
    effects: { ...contract.effects },
    returns_target_content: contract.returnsTargetContent,
    annotations: contract.annotations,
    input_schema: presentAdvertisedInputSchema(
      advertisedInputJsonSchema(contract),
      compactPresentation,
    ),
    output_schema: toolOutputSchemaWithMetadata(contract)[
      "~standard"
    ].jsonSchema.output({ target: "draft-2020-12" }),
  }));

const createPromptCatalog = (contracts: readonly PromptContract[]) =>
  contracts
    .map((contract) => ({
      name: contract.name,
      title: contract.title,
      description: contract.description,
      objective: contract.objective,
      arguments: contract.arguments,
      steps: contract.steps,
    }))
    .sort((left, right) => compareUnicodeCodePoints(left.name, right.name));

const promptCatalog = createPromptCatalog(PROMPT_CONTRACTS);

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Catalog is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};

/**
 * Catalog digests over the given tool contracts. Exported so tests can prove
 * which contract fields the identity covers; production uses
 * {@link CATALOG_IDENTITY}.
 */
export const createCatalogDigests = (
  contracts: readonly ToolContract[] = TOOL_CONTRACTS,
  promptContracts: readonly PromptContract[] = PROMPT_CONTRACTS,
  compactPresentation: CompactInputSchemaPresentation | undefined = undefined,
  outputSchemaProfile: McpOutputSchemaProfile = "full",
) => {
  const tools = {
    output_schema_profile: outputSchemaProfile,
    catalog: createToolCatalog(sortByName(contracts), compactPresentation),
  };
  const prompts = createPromptCatalog(promptContracts);
  return {
    tools_sha256: digest(tools),
    prompts_sha256: digest(prompts),
    combined_sha256: digest({
      cli: CLI_COMMAND_NAMES,
      tools,
      prompts,
    }),
  } as const;
};

export type CatalogDigests = ReturnType<typeof createCatalogDigests>;

export const createCatalogIdentity = (
  compactPresentation: CompactInputSchemaPresentation | undefined = undefined,
  outputSchemaProfile: McpOutputSchemaProfile = "full",
) => {
  const selectedPresentation =
    compactPresentation === undefined
      ? undefined
      : { budgetBytes: compactPresentation.budgetBytes };
  // Building and canonicalizing every advertised schema dominates doctor and
  // server startup, so the compiled runtime records the default digests once.
  let catalogDigests: CatalogDigests | undefined =
    selectedPresentation === undefined && outputSchemaProfile === "full"
      ? RECORDED_CATALOG_DIGESTS
      : undefined;
  return {
    counts: {
      cli_commands: CLI_COMMAND_NAMES.length,
      mcp_tools: sortedToolContracts.length,
      mcp_prompts: promptCatalog.length,
    },
    get digests() {
      return (catalogDigests ??= createCatalogDigests(
        TOOL_CONTRACTS,
        PROMPT_CONTRACTS,
        selectedPresentation,
        outputSchemaProfile,
      ));
    },
  } as const;
};

/**
 * Stable, schema-sensitive identity; schema digests are recorded at build time
 * or computed on first use.
 */
export const CATALOG_IDENTITY = createCatalogIdentity();
