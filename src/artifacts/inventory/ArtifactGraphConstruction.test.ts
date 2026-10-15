import { describe, expect, it } from "vitest";

import { CPU, fatImage, machoImage } from "../apple/MachoImage.fixture.js";
import {
  classifyArtifactContent,
  createArtifactEdges,
  createOccurrence,
  indexOccurrencesByPath,
  resolveOccurrenceParents,
} from "./ArtifactGraphConstruction.js";
import { artifactIdForContent } from "../../domain/artifactIdentity.js";
import type { ArtifactEntry } from "../ArtifactReader.js";

const entry = (path: string, kind: ArtifactEntry["kind"]): ArtifactEntry => ({
  path,
  kind,
  declaredSize: null,
  compressedSize: null,
  executable: false,
  encrypted: false,
  byteOffset: null,
  declaredSha256: null,
  unpacked: false,
  limitations: [],
  adapterKey: path,
});

describe("occurrence parent ownership", () => {
  it("selects the nearest unique nested parent", () => {
    const outer = createOccurrence(entry("a", "directory"), "a", null);
    const inner = createOccurrence(entry("a/b", "directory"), "a/b", null);
    const file = createOccurrence(entry("a/b/file", "file"), "a/b/file", null);
    const occurrences = [outer, inner, file];

    resolveOccurrenceParents(
      occurrences,
      indexOccurrencesByPath(occurrences),
      new Set(),
    );

    expect(file.parent_occurrence_id).toBe(inner.occurrence_id);
  });

  it("leaves a child unparented when duplicate directories make ownership ambiguous", () => {
    const first = createOccurrence(entry("a", "directory"), "a", null, 0);
    const second = createOccurrence(entry("a", "directory"), "a", null, 1);
    const file = createOccurrence(entry("a/file", "file"), "a/file", null);
    const occurrences = [first, second, file];

    const resolution = resolveOccurrenceParents(
      occurrences,
      indexOccurrencesByPath(occurrences),
      new Set(),
    );

    expect(file.parent_occurrence_id).toBeNull();
    expect(resolution.unknownParentOccurrences.has(file)).toBe(true);
    expect(resolution.limitations).toContain(
      'The parent occurrence for "a/file" is unknown because multiple observed directory or container occurrences share "a".',
    );
    expect([first, second].map(({ hash_status }) => hash_status)).toEqual([
      "unavailable",
      "unavailable",
    ]);
  });
});

describe("source-map artifact relationships", () => {
  const contentId = (digit: string): string =>
    artifactIdForContent(digit.repeat(64));

  it.each([
    ["missing target", [] as string[], "contains"],
    ["unread target", ["unread"] as string[], "contains"],
    ["unique identified target", ["identified"] as string[], "maps-source"],
    ["duplicate targets", ["identified", "identified"] as string[], "contains"],
  ] as const)(
    "uses a truthful edge for a %s",
    (_label, targetIdentities, relation) => {
      const directory = createOccurrence(
        entry("app", "directory"),
        "app",
        null,
      );
      directory.artifact_id = contentId("1");
      const targets = targetIdentities.map((identity, index) => {
        const target = createOccurrence(
          entry("app/main.js", "file"),
          "app/main.js",
          directory.occurrence_id,
          index,
        );
        target.artifact_id = identity === "unread" ? null : contentId("2");
        return target;
      });
      const sourceMap = createOccurrence(
        entry("app/main.js.map", "file"),
        "app/main.js.map",
        directory.occurrence_id,
      );
      sourceMap.artifact_id = contentId("3");

      const result = createArtifactEdges(contentId("4"), [
        directory,
        ...targets,
        sourceMap,
      ]);
      const edge = result.edges.find(
        ({ occurrence_id }) => occurrence_id === sourceMap.occurrence_id,
      );

      expect(edge).toMatchObject({
        relation,
        parent_artifact_id:
          relation === "maps-source" ? contentId("2") : contentId("1"),
        occurrence_id: sourceMap.occurrence_id,
      });
      expect(result.limitations.length > 0).toBe(
        (targetIdentities.length === 1 && targetIdentities[0] === "unread") ||
          targetIdentities.length > 1,
      );
    },
  );
});

const fat = (wide = false): Buffer =>
  Buffer.from(fatImage([{ cpu: CPU.arm64, bytes: machoImage({}) }], wide));

describe("bounded FAT inventory classification", () => {
  it("requires the complete table but not slice bytes in the retained prefix", () => {
    const bytes = fat();
    for (const length of [4, 7, 8, 27]) {
      expect(
        classifyArtifactContent(
          "native",
          bytes.subarray(0, length),
          bytes.length,
        ),
      ).toEqual({ kind: "unknown", format: "unknown" });
    }
    expect(
      classifyArtifactContent(
        "native.class",
        bytes.subarray(0, 28),
        bytes.length,
      ),
    ).toEqual({ kind: "executable", format: "mach-o-universal" });
  });

  it.each([
    ["empty table", (bytes: Buffer) => bytes.writeUInt32BE(0, 4)],
    ["slice overlapping table", (bytes: Buffer) => bytes.writeUInt32BE(0, 16)],
    ["empty slice", (bytes: Buffer) => bytes.writeUInt32BE(0, 20)],
    [
      "slice beyond file",
      (bytes: Buffer) => bytes.writeUInt32BE(bytes.length, 20),
    ],
    ["unaligned slice", (bytes: Buffer) => bytes.writeUInt32BE(4097, 16)],
    ["unsupported alignment", (bytes: Buffer) => bytes.writeUInt32BE(53, 24)],
  ] as const)("keeps %s unknown", (_label, mutate) => {
    const bytes = fat();
    mutate(bytes);
    expect(classifyArtifactContent("native", bytes)).toEqual({
      kind: "unknown",
      format: "unknown",
    });
  });

  it("does not infer Mach-O from an out-of-bounds architecture count", () => {
    const bytes = fat();
    bytes.writeUInt32BE(0xffffffff, 4);
    expect(classifyArtifactContent("native", bytes)).toEqual({
      kind: "resource",
      format: "file",
    });
  });

  it("does not lose unsafe FAT64 range values to number conversion", () => {
    const bytes = fat(true);
    bytes.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 16);
    expect(classifyArtifactContent("native", bytes)).toEqual({
      kind: "unknown",
      format: "unknown",
    });
  });

  it("requires valid ranges for every declared slice", () => {
    const bytes = Buffer.from(
      fatImage([
        { cpu: CPU.arm64, bytes: machoImage({}) },
        { cpu: CPU.x86_64, bytes: machoImage({ cpu: CPU.x86_64 }) },
      ]),
    );
    bytes.writeUInt32BE(bytes.length, 40);
    expect(classifyArtifactContent("native", bytes)).toEqual({
      kind: "unknown",
      format: "unknown",
    });
  });

  it("requires observed slice magic for an unknown CPU type", () => {
    const cpu = { type: 0x12345678, subtype: 0 };
    const bytes = Buffer.from(fatImage([{ cpu, bytes: machoImage({ cpu }) }]));
    expect(
      classifyArtifactContent("native", bytes.subarray(0, 28), bytes.length),
    ).toEqual({ kind: "unknown", format: "unknown" });
    expect(classifyArtifactContent("native", bytes)).toEqual({
      kind: "executable",
      format: "mach-o-universal",
    });
  });

  it.each([NaN, Infinity, -1, 8.5, Number.MAX_SAFE_INTEGER + 1, 27])(
    "keeps invalid or contradictory file size %s unknown",
    (size) => {
      const bytes = fat();
      expect(classifyArtifactContent("native", bytes, size)).toEqual({
        kind: "unknown",
        format: "unknown",
      });
    },
  );
});

it("preserves path-selected inventory roles for XML content", () => {
  const xml = Buffer.from(
    '<?xml version="1.0"?><plist version="1.0"><dict/></plist>',
  );
  expect(classifyArtifactContent("state.archive", xml)).toEqual({
    kind: "plist",
    format: "plist",
  });
  expect(classifyArtifactContent("state.js", xml)).toEqual({
    kind: "javascript",
    format: "javascript-bundle",
  });
  expect(classifyArtifactContent("state.map", xml)).toEqual({
    kind: "source-map",
    format: "source-map",
  });
  expect(classifyArtifactContent("state.asar", xml)).toEqual({
    kind: "resource",
    format: "file",
  });
});
