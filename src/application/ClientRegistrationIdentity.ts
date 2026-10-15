import { isAbsolute, resolve } from "node:path";
import { valid } from "semver";

import { PRODUCT_IDENTITY } from "../identity.js";

/** Package runners whose pinned launcher setup can register. */
export type PackageRunner = "npx" | "bunx";

/** Read one variable; Windows variable names are case-insensitive. */
const environmentValue = (
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined => {
  if (platform !== "win32") return environment[name];
  const target = name.toLowerCase();
  const key = Object.keys(environment).findLast(
    (candidate) => candidate.toLowerCase() === target,
  );
  return key === undefined ? undefined : environment[key];
};

/** Identify the package runner that launched this process, if any. */
export const invokingPackageRunner = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): PackageRunner | undefined => {
  if (environmentValue(environment, "npm_command", platform) !== "exec")
    return undefined;
  // `bunx` and `bun x` also report npm_command=exec, with a bun user agent.
  return environmentValue(
    environment,
    "npm_config_user_agent",
    platform,
  )?.startsWith("bun/") === true
    ? "bunx"
    : "npx";
};

/** Copy an environment without the variable that marks a package-runner launch. */
export const withoutPackageRunnerIdentity = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(([key]) =>
      platform === "win32"
        ? key.toLowerCase() !== "npm_command"
        : key !== "npm_command",
    ),
  );

/** Resolve a pinned package-runner launcher that stdio clients can spawn on the host. */
export const packageRunnerRegistrationCommand = (
  runner: PackageRunner,
  platform: NodeJS.Platform = process.platform,
): readonly string[] => {
  const command =
    runner === "npx"
      ? ["npx", "-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"]
      : ["bunx", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"];
  // Both runners may be .cmd shims on Windows, which clients cannot spawn directly.
  return platform === "win32" ? ["cmd.exe", "/d", "/c", ...command] : command;
};

/** Resolve a pinned npx launcher that stdio clients can spawn on the host. */
export const npxRegistrationCommand = (
  platform: NodeJS.Platform = process.platform,
): readonly string[] => packageRunnerRegistrationCommand("npx", platform);

const unwrapCmdCommand = (command: readonly string[]): readonly string[] => {
  const executable = command[0]?.toLowerCase();
  if (executable !== "cmd" && executable !== "cmd.exe") return command;
  if (command[1]?.toLowerCase() === "/c") return command.slice(2);
  if (command[1]?.toLowerCase() === "/d" && command[2]?.toLowerCase() === "/c")
    return command.slice(3);
  return [];
};

/** Preserve the package argument from a supported package-runner command. */
export const clientRegistrationPackageReference = (
  command: readonly string[],
): string | undefined => {
  const arguments_ = unwrapCmdCommand(command);
  if (
    arguments_.length === 4 &&
    arguments_[0] === "npx" &&
    arguments_[1] === "-y" &&
    arguments_[3] === "mcp"
  )
    return arguments_[2];
  if (
    arguments_.length === 3 &&
    arguments_[0] === "bunx" &&
    arguments_[2] === "mcp"
  )
    return arguments_[1];
  return undefined;
};

const isOwnedPackageReference = (packageReference: string): boolean => {
  if (
    packageReference === PRODUCT_IDENTITY.packageName ||
    packageReference === PRODUCT_IDENTITY.packageSpecifier ||
    packageReference === PRODUCT_IDENTITY.registrationPackageSpecifier
  )
    return true;
  const versionPrefix = `${PRODUCT_IDENTITY.packageName}@`;
  return (
    packageReference.startsWith(versionPrefix) &&
    valid(packageReference.slice(versionPrefix.length)) !== null
  );
};

/** Check that one parsed command points to REA's MCP entry point. */
export type ClientRegistrationCommandIdentity = "owned" | "foreign" | "unknown";

/** Classify only what the command and current executable identity establish. */
export const classifyClientRegistrationCommand = (
  command: readonly string[],
  currentCommandPath: string | undefined,
): ClientRegistrationCommandIdentity => {
  const packageReference = clientRegistrationPackageReference(command);
  if (packageReference !== undefined)
    return isOwnedClientRegistrationCommand(command, currentCommandPath)
      ? "owned"
      : "foreign";
  const currentPathAvailable =
    currentCommandPath !== undefined && currentCommandPath.length > 0;
  const nodeScript = command.length === 3 && command[2] === "mcp";
  if (nodeScript) {
    if (
      !isAbsolute(command[0] ?? "") ||
      !isAbsolute(command[1] ?? "") ||
      !currentPathAvailable
    )
      return "unknown";
    return isOwnedClientRegistrationCommand(command, currentCommandPath)
      ? "owned"
      : "foreign";
  }
  if (command.length === 2 && command[1] === "mcp") {
    const executable = command[0] ?? "";
    if (executable === PRODUCT_IDENTITY.cliBinary) return "owned";
    const relativePathLike =
      !isAbsolute(executable) && /[./\\]/u.test(executable);
    if (relativePathLike || (isAbsolute(executable) && !currentPathAvailable))
      return "unknown";
  }
  if (isOwnedClientRegistrationCommand(command, currentCommandPath))
    return "owned";
  return "foreign";
};

export const isOwnedClientRegistrationCommand = (
  command: readonly string[],
  currentCommandPath: string | undefined,
): boolean => {
  if (
    currentCommandPath !== undefined &&
    currentCommandPath.length > 0 &&
    command.length === 3 &&
    command[2] === "mcp" &&
    isAbsolute(command[0] ?? "") &&
    isAbsolute(command[1] ?? "") &&
    resolve(command[0] ?? "") === resolve(process.execPath) &&
    resolve(command[1] ?? "") === currentCommandPath
  )
    return true;

  if (command.length === 2 && command[1] === "mcp") {
    const executable = command[0] ?? "";
    if (
      executable === PRODUCT_IDENTITY.cliBinary ||
      (isAbsolute(executable) &&
        currentCommandPath !== undefined &&
        currentCommandPath.length > 0 &&
        resolve(executable) === currentCommandPath)
    )
      return true;
  }

  const packageReference = clientRegistrationPackageReference(command);
  return (
    packageReference !== undefined && isOwnedPackageReference(packageReference)
  );
};
