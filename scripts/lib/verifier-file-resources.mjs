import { hashStableFile } from "../../dist/filesystem/StableFileHash.js";

/** Hash one verifier input while retaining any descriptor whose close fails. */
export function hashVerifierFile(path, resources) {
  return hashStableFile(path, {
    retainFailedClose(owner) {
      resources.retain({ kind: "file-handle", resource: path, handle: owner });
    },
  });
}
