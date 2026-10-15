import { err, ok, type Result } from "../domain/result.js";
import {
  RegularFileCleanupFailure,
  readRegularFileText,
} from "./RegularFileRead.js";
import {
  effectiveClientServer,
  parseClientConfiguration,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import type { SetupClient } from "./SupportedClients.js";
import { clientRegistrationEnvironment } from "./ClientRegistrationEnvironment.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";

/** A parsed layer retains its path so rereading the write target replaces only that layer. */
export interface ClientConfigurationSource extends ClientConfigurationDocument {
  readonly sourcePath: string;
}

const invalidEnvironment = (
  path: string,
  error: ConfigurationError,
): ClientConfigurationFileError => ({
  kind: "malformed",
  path,
  detail: `Configuration ${path} has an invalid REA server environment: ${error.settings.map(({ setting, constraint }) => `${setting}: ${constraint}`).join("; ")}. Repair it before rerunning setup.`,
});

/** A named source failure that setup can explain without losing the bad path. */
export interface ClientConfigurationFileError {
  readonly kind: "unreadable" | "malformed";
  readonly path: string;
  readonly detail: string;
  readonly cleanupFailure?: RegularFileCleanupFailure;
}

/** Preserve named read failures and distinguish a missing source from an empty file. */
export const readConfigurationText = async (
  path: string,
  resources?: ArtifactResourceScope,
): Promise<Result<string | undefined, ClientConfigurationFileError>> => {
  try {
    return ok(
      await readRegularFileText(
        path,
        resources === undefined ? {} : { resources },
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return ok(undefined);
    return err({
      kind: "unreadable",
      path,
      detail: `Configuration ${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      ...(cause instanceof RegularFileCleanupFailure
        ? { cleanupFailure: cause }
        : {}),
    });
  }
};

/** Read and parse one configuration at its source boundary. */
export const readConfigurationFile = async (
  path: string,
  format: SetupClient["format"],
  resources?: ArtifactResourceScope,
): Promise<
  Result<ClientConfigurationDocument | undefined, ClientConfigurationFileError>
> => {
  const source = await readConfigurationText(path, resources);
  if (!source.ok) return source;
  const content = source.value;
  if (content === undefined) return ok(undefined);
  try {
    return ok(parseClientConfiguration(content, format));
  } catch (cause: unknown) {
    return err({
      kind: "malformed",
      path,
      detail: `Configuration ${path} is malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
};

/** Read every applicable user file; malformed lower-priority files also stop setup. */
export const readClientConfigurationFiles = async (
  client: SetupClient,
  resources?: ArtifactResourceScope,
): Promise<
  Result<readonly ClientConfigurationSource[], ClientConfigurationFileError>
> => {
  const documents: ClientConfigurationSource[] = [];
  for (const path of client.configPaths ?? [client.configPath]) {
    const document = await readConfigurationFile(
      path,
      client.format,
      resources,
    );
    if (!document.ok) return document;
    if (document.value !== undefined) {
      const environment = clientRegistrationEnvironment(
        document.value,
        {},
        "fragment",
      );
      if (!environment.ok)
        return err(invalidEnvironment(path, environment.error));
      documents.push({ ...document.value, sourcePath: path });
    }
  }
  const environment = clientRegistrationEnvironment(
    effectiveClientConfiguration(documents),
  );
  if (!environment.ok)
    return err(invalidEnvironment(client.configPath, environment.error));
  return ok(documents);
};

/** OpenCode merges server objects in file order, replacing arrays and scalar values. */
const mergeConfigurationValue = (previous: unknown, next: unknown): unknown => {
  if (!isObject(previous) || !isObject(next)) return next;
  return Object.fromEntries(
    [...new Set([...Object.keys(previous), ...Object.keys(next)])].map(
      (key) => [
        key,
        Object.hasOwn(next, key)
          ? mergeConfigurationValue(previous[key], next[key])
          : previous[key],
      ],
    ),
  );
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Project a client's effective user registration without modifying its source files. */
export const effectiveClientConfiguration = (
  sources: readonly ClientConfigurationSource[],
  target?: {
    readonly client: Pick<SetupClient, "configPath" | "configPaths">;
    readonly document: ClientConfigurationDocument | undefined;
  },
): ClientConfigurationDocument | undefined => {
  const documents =
    target === undefined
      ? sources
      : (target.client.configPaths ?? [target.client.configPath]).flatMap(
          (path) => {
            const document =
              path === target.client.configPath
                ? target.document
                : sources.find(({ sourcePath }) => sourcePath === path);
            return document === undefined ? [] : [document];
          },
        );
  const last = documents.at(-1);
  if (last === undefined) return undefined;
  if (documents.length === 1) return last;
  const servers: Record<string, unknown> = {};
  for (const document of documents) {
    const names = new Set([
      ...Object.keys(document.legacyServers),
      ...Object.keys(document.servers),
    ]);
    for (const name of names)
      servers[name] = mergeConfigurationValue(
        servers[name],
        effectiveClientServer(document, name),
      );
  }
  return { ...last, servers, legacyServers: {} };
};

/** Read the configuration ZCode will load, preserving its same-scope fallback rule. */
export const readEffectiveClientRegistrationConfiguration = async (
  client: SetupClient,
  resources?: ArtifactResourceScope,
): Promise<
  Result<
    {
      readonly document: ClientConfigurationDocument | undefined;
      readonly configPath: string;
    },
    ClientConfigurationFileError
  >
> => {
  const nativeSources = await readClientConfigurationFiles(client, resources);
  if (!nativeSources.ok) return nativeSources;
  const nativeDocument = effectiveClientConfiguration(nativeSources.value);
  const fallbackPath =
    client.format === "zcode" ? client.zcodeFallbackPath : undefined;
  if (
    fallbackPath === undefined ||
    (nativeDocument !== undefined &&
      Object.keys(nativeDocument.servers).length > 0)
  )
    return ok({ document: nativeDocument, configPath: client.configPath });

  const fallbackClient: SetupClient = {
    ...client,
    configPath: fallbackPath,
    configPaths: [fallbackPath],
    format: "zcode_fallback",
  };
  const fallbackSources = await readClientConfigurationFiles(
    fallbackClient,
    resources,
  );
  if (!fallbackSources.ok) return fallbackSources;
  const fallbackDocument = effectiveClientConfiguration(fallbackSources.value);
  return ok(
    fallbackDocument === undefined
      ? { document: nativeDocument, configPath: client.configPath }
      : { document: fallbackDocument, configPath: fallbackPath },
  );
};
