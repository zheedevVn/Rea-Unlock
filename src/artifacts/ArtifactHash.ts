import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { streamChunkToBuffer } from "./StreamBytes.js";
import {
  createXmlPlistSignatureProbe,
  MAX_XML_PLIST_PROBE_BYTES,
} from "../domain/apple/appleArchiveFormat.js";

/** Full stream digest and byte count with bounded classification evidence. */
export type HashResult = {
  readonly sha256: string;
  readonly bytes: number;
  readonly prefix: Buffer;
};

/** Bounded classification evidence; this is not an executable format size limit. */
export const ARTIFACT_CLASSIFICATION_PREFIX_BYTES = 8_192;

/** Preserve the inventory cancellation reason at a stream boundary. */
export const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "Artifact inventory cancelled",
      { cause: signal.reason },
    );
};

/** Hash every stream byte and retain its bounded classification prefix. */
export const hashReadable = async (
  stream: Readable,
  signal?: AbortSignal,
): Promise<HashResult> => {
  const hash = createHash("sha256");
  const prefixes: Buffer[] = [];
  let prefixBytes = 0;
  const xmlProbe = createXmlPlistSignatureProbe();
  let bytes = 0;
  for await (const raw of stream) {
    abortIfNeeded(signal);
    const chunk = streamChunkToBuffer(raw);
    bytes += chunk.length;
    hash.update(chunk);
    let chunkOffset = 0;
    while (
      chunkOffset < chunk.length &&
      (prefixBytes < ARTIFACT_CLASSIFICATION_PREFIX_BYTES ||
        (xmlProbe.state === "pending" &&
          prefixBytes < MAX_XML_PLIST_PROBE_BYTES))
    ) {
      const limit =
        prefixBytes < ARTIFACT_CLASSIFICATION_PREFIX_BYTES
          ? ARTIFACT_CLASSIFICATION_PREFIX_BYTES
          : MAX_XML_PLIST_PROBE_BYTES;
      const selected = chunk.subarray(
        chunkOffset,
        Math.min(chunkOffset + limit - prefixBytes, chunk.length),
      );
      prefixes.push(selected);
      prefixBytes += selected.length;
      chunkOffset += selected.length;
      xmlProbe.write(selected);
    }
  }
  abortIfNeeded(signal);
  return { sha256: hash.digest("hex"), bytes, prefix: Buffer.concat(prefixes) };
};
