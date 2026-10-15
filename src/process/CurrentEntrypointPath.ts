import { resolve } from "node:path";

/** Absolute argv entrypoint, or undefined when the process did not supply one. */
export const normalizeEntrypointPath = (
  entrypoint: string | undefined,
): string | undefined =>
  entrypoint === undefined || entrypoint.length === 0
    ? undefined
    : resolve(entrypoint);

export const CURRENT_ENTRYPOINT_PATH = normalizeEntrypointPath(process.argv[1]);
