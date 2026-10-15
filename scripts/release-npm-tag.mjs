import semver from "semver";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function releaseNpmTag(version) {
  if (version === undefined || semver.valid(version) !== version)
    throw new Error("Expected an exact SemVer version.");
  return semver.prerelease(version) === null ? "latest" : "next";
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.stdout.write(releaseNpmTag(process.argv[2]));
