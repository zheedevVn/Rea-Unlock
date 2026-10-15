/** Snapshot selected variables while preserving platform and caller precedence. */
export const snapshotEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): Readonly<NodeJS.ProcessEnv> => {
  if (platform !== "win32") return Object.freeze({ ...environment });
  const selected = new Map<string, string | undefined>();
  // Fold aliases in caller order so an explicit later override wins before
  // this canonical environment crosses a Windows process boundary.
  for (const [key, value] of Object.entries(environment))
    selected.set(key.toUpperCase(), value);
  const snapshot: NodeJS.ProcessEnv = {};
  for (const key of [...selected.keys()].sort())
    snapshot[key] = selected.get(key);
  return Object.freeze(snapshot);
};
