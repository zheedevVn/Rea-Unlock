import { z } from "zod";

import { err, ok, type Result } from "../domain/result.js";

/**
 * One function block in a `kuna decompile-project` `.c` file. The span covers
 * its `// Function:` header through the blank line that ends the block, which
 * is how REA serves one function without reading the whole file.
 */
export interface KunaProjectFunction {
  readonly name: string;
  /** Kuna's display address, a lowercase `0x…` virtual address. */
  readonly address: string;
  readonly cOffset: number;
  readonly cLength: number;
  /** Kuna's own failure for this function; its block is then the header alone. */
  readonly error: string | null;
}

// Rendered by kuna-console's `render_c`: `// Function: {name} @ 0x{addr:x}`,
// or `... @ 0x{addr:x}  (error: {message})` for a failed function. A name
// can itself contain " @ ", so the address is the last such field.
const HEADER = /^\/\/ Function: (.+) @ (0x[0-9a-f]+)(?: {2}\(error: (.*)\))?$/u;
const HEADER_PREFIX = "// Function: ";

/** Kuna's completed-export summary on stdout: `functions: N ok, M failed`. */
const SUMMARY = /functions: (\d+) ok, (\d+) failed/u;

/** Function counts Kuna reported for a finished export. */
export interface KunaExportSummary {
  readonly decompiled: number;
  readonly failed: number;
}

/** Read the completed-file summary Kuna prints after finalizing an export. */
export const parseKunaExportSummary = (
  stdout: string,
): KunaExportSummary | undefined => {
  const match = SUMMARY.exec(stdout);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { decompiled: Number(match[1]), failed: Number(match[2]) };
};

/** A header line longer than this is not one Kuna wrote. */
const MAX_HEADER_BYTES = 64 * 1024;
const PREFIX_BYTES = Buffer.from(HEADER_PREFIX);

interface Header {
  readonly name: string;
  readonly address: string;
  readonly error: string | null;
  readonly offset: number;
}

/**
 * Split a finished export's `.c` into its function blocks, reading it as a
 * stream so a very large export is never held in memory.
 *
 * The `#include` preamble precedes the first header. The header count must
 * equal the functions Kuna reported, and every address must be distinct; an
 * export that fails either check is not a usable function inventory.
 */
export const scanKunaProjectSource = async (
  chunks: AsyncIterable<Buffer>,
  summary: KunaExportSummary,
): Promise<Result<readonly KunaProjectFunction[], string>> => {
  const headers: Header[] = [];
  let offset = 0;
  let lineStart = 0;
  // Bytes of the current line, kept only while it may still be a header.
  let line: Buffer[] | undefined = [];
  let lineBytes = 0;
  const endLine = (): string | undefined => {
    if (line === undefined) return undefined;
    const text = Buffer.concat(line).toString("utf8");
    if (!text.startsWith(HEADER_PREFIX)) return undefined;
    const match = HEADER.exec(text);
    if (match?.[1] === undefined || match[2] === undefined)
      return `unrecognized function header at byte ${String(lineStart)}`;
    headers.push({
      name: match[1],
      address: match[2],
      error: match[3] ?? null,
      offset: lineStart,
    });
    return undefined;
  };
  for await (const chunk of chunks) {
    let position = 0;
    while (position < chunk.length) {
      const newline = chunk.indexOf(0x0a, position);
      const end = newline === -1 ? chunk.length : newline;
      if (line !== undefined) {
        const segment = chunk.subarray(position, end);
        line.push(segment);
        lineBytes += segment.length;
        const seen = Buffer.concat(line).subarray(0, PREFIX_BYTES.length);
        if (!PREFIX_BYTES.subarray(0, seen.length).equals(seen))
          line = undefined;
        else if (lineBytes > MAX_HEADER_BYTES)
          return err(
            `function header at byte ${String(lineStart)} is too long`,
          );
      }
      if (newline === -1) break;
      const failure = endLine();
      if (failure !== undefined) return err(failure);
      position = newline + 1;
      lineStart = offset + position;
      line = [];
      lineBytes = 0;
    }
    offset += chunk.length;
  }
  const failure = endLine();
  if (failure !== undefined) return err(failure);
  const total = offset;
  const expected = summary.decompiled + summary.failed;
  if (headers.length !== expected)
    return err(
      `the .c holds ${String(headers.length)} function headers but Kuna reported ${String(expected)} functions`,
    );
  const failed = headers.filter(({ error }) => error !== null).length;
  if (failed !== summary.failed)
    return err(
      `the .c marks ${String(failed)} failed functions but Kuna reported ${String(summary.failed)}`,
    );
  const addresses = new Set<string>();
  const functions: KunaProjectFunction[] = [];
  for (const [index, header] of headers.entries()) {
    if (addresses.has(header.address))
      return err(`the .c repeats address ${header.address}`);
    addresses.add(header.address);
    const end = headers[index + 1]?.offset ?? total;
    functions.push({
      name: header.name,
      address: header.address,
      cOffset: header.offset,
      cLength: end - header.offset,
      error: header.error,
    });
  }
  return ok(functions);
};

const inventorySchema = z.object({
  functions: z.array(
    z.object({
      name: z.string(),
      address_hex: z.string().regex(/^0x[0-9a-f]+$/u),
      aliases: z.array(z.string()),
      size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
  ),
});

/** One callable entry from `kuna functions --json`, including imports Kuna does not decompile. */
export interface KunaInventoryFunction {
  readonly name: string;
  readonly address: string;
  readonly aliases: readonly string[];
  /** Inventory extent: an upper bound clipped at the next entry, or 0 when unmeasured. */
  readonly size: number;
}

/** Parse the callable-symbol inventory `kuna functions --json` writes. */
export const parseKunaInventory = (
  text: string,
): Result<readonly KunaInventoryFunction[], string> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err("the function inventory is not JSON");
  }
  const parsed = inventorySchema.safeParse(value);
  if (!parsed.success)
    return err(
      `the function inventory does not match Kuna's document: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  return ok(
    parsed.data.functions.map((entry) => ({
      name: entry.name,
      address: entry.address_hex,
      aliases: entry.aliases,
      size: entry.size,
    })),
  );
};
