/** Bounded CPython .pyc reader: magic, version, and code-object inventory. */

const MAX_DEPTH = 32;
const MAX_ITEMS = 10_000;
const MAX_STRING = 1_000_000;

/** CPython magic numbers (little-endian uint32) for supported versions. */
const MAGIC_VERSIONS: Readonly<Record<number, string>> = {
  3180: "3.2",
  3250: "3.3",
  3310: "3.4",
  3351: "3.5",
  3379: "3.6",
  3394: "3.7",
  3413: "3.8",
  3425: "3.9",
  3439: "3.10",
  3495: "3.11",
  3531: "3.12",
  3559: "3.13",
};

export interface PythonCodeObject {
  readonly name: string;
  readonly filename: string;
  readonly firstLine: number;
  readonly argCount: number;
  /** Global and attribute names referenced by this code object. */
  readonly names: readonly string[];
  /** String constants directly reachable from this code object. */
  readonly constStrings: readonly string[];
  readonly nestedCodeObjects: readonly PythonCodeObject[];
}

export interface PythonBytecodeReport {
  readonly magic: number;
  readonly version: string | null;
  readonly topLevel: PythonCodeObject | null;
  readonly limitations: readonly string[];
}

/** Minimal marshal reader over a Buffer, with ref tracking (FLAG_REF). */
class MarshalReader {
  private offset = 0;
  private items = 0;
  private readonly refs: unknown[] = [];

  constructor(
    private readonly buffer: Buffer,
    private readonly major: number,
    private readonly minor: number,
  ) {}

  private take(count: number): Buffer {
    if (count < 0 || this.offset + count > this.buffer.length)
      throw new Error("marshal data truncated");
    const slice = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  private byte(): number {
    return this.take(1)[0] ?? 0;
  }

  private int32(): number {
    return this.take(4).readInt32LE(0);
  }

  private uint8(): number {
    return this.take(1)[0] ?? 0;
  }

  private counted(): void {
    this.items += 1;
    if (this.items > MAX_ITEMS) throw new Error("marshal item budget exceeded");
  }

  private bytes(length: number): Buffer {
    if (length > MAX_STRING) throw new Error("marshal string too large");
    return this.take(length);
  }

  private text(length: number): string {
    return this.bytes(length).toString("utf8");
  }

  /** Read one marshal value. Returns null for TYPE_NULL. */
  value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new Error("marshal nesting too deep");
    this.counted();
    const raw = this.byte();
    const flagRef = (raw & 0x80) !== 0;
    const type = String.fromCharCode(raw & 0x7f);
    if (type === "c" && flagRef) {
      // Code objects reserve their refs slot before their fields are read
      // (CPython r_ref_reserve / r_ref_insert), so inner references can
      // address enclosing code objects.
      const index = this.refs.length;
      this.refs.push(null);
      const code = this.codeObject(depth);
      this.refs[index] = code;
      return code;
    }
    const result = this.readTyped(type, depth, flagRef);
    // Atoms register after reading; containers already registered inside
    // readTyped before their contents.
    if (flagRef && !["(", ")", "[", "{", ">", "<"].includes(type))
      this.refs.push(result);
    return result;
  }

  /**
   * Read one typed marshal value. Containers are registered in refs before
   * their contents are read (CPython semantics); atoms are registered after.
   */
  private readTyped(type: string, depth: number, flagRef: boolean): unknown {
    switch (type) {
      case "0":
        return null;
      case "N":
        return null;
      case "F":
        return false;
      case "T":
        return true;
      case "S":
        return "StopIteration";
      case ".":
        return "Ellipsis";
      case "i":
        return this.int32();
      case "I":
        // TYPE_INT64 (legacy): 8-byte signed integer.
        return Number(this.take(8).readBigInt64LE(0));
      case "l": {
        const low = this.take(4).readUInt32LE(0);
        const high = this.take(4).readInt32LE(0);
        return high * 0x1_0000_0000 + low;
      }
      case "f": {
        // TYPE_FLOAT: legacy ASCII repr stored as a length-prefixed string.
        const length = this.uint8();
        return Number.parseFloat(this.text(length));
      }
      case "g":
        return this.take(8).readDoubleLE(0);
      case "x": {
        // TYPE_COMPLEX (legacy): two length-prefixed float reprs.
        const realLength = this.uint8();
        this.text(realLength);
        const imagLength = this.uint8();
        this.text(imagLength);
        return "complex";
      }
      case "y":
        // TYPE_BINARY_COMPLEX: two 8-byte doubles.
        this.take(16);
        return "complex";
      case "s": {
        const length = this.int32();
        return this.bytes(length);
      }
      case "t":
      case "A":
      case "u":
      case "a": {
        const length = this.int32();
        return this.text(length);
      }
      case "Z":
      case "z": {
        const length = this.uint8();
        return this.text(length);
      }
      case "r": {
        const index = this.int32();
        return this.refs[index] ?? null;
      }
      case ")": {
        // TYPE_SMALL_TUPLE: 1-byte length.
        const length = this.uint8();
        const items: unknown[] = [];
        if (flagRef) this.refs.push(items);
        for (let i = 0; i < length; i += 1) items.push(this.value(depth + 1));
        return items;
      }
      case "(": {
        const length = this.int32();
        const items: unknown[] = [];
        if (flagRef) this.refs.push(items);
        for (let i = 0; i < length; i += 1) items.push(this.value(depth + 1));
        return items;
      }
      case "[": {
        const length = this.int32();
        const items: unknown[] = [];
        if (flagRef) this.refs.push(items);
        for (let i = 0; i < length; i += 1) items.push(this.value(depth + 1));
        return items;
      }
      case "{": {
        const entries: Record<string, unknown> = {};
        if (flagRef) this.refs.push(entries);
        for (;;) {
          const key = this.value(depth + 1);
          if (key === null) break;
          entries[String(key)] = this.value(depth + 1);
        }
        return entries;
      }
      case ">":
      case "<": {
        const length = this.int32();
        const items: unknown[] = [];
        if (flagRef) this.refs.push(items);
        for (let i = 0; i < length; i += 1) items.push(this.value(depth + 1));
        return items;
      }
      case "c":
        return this.codeObject(depth);
      default:
        throw new Error(`unsupported marshal type ${JSON.stringify(type)}`);
    }
  }

  /**
   * Decode one code object. Field order follows CPython's marshal for code
   * objects: posonlyargcount exists from 3.8; 3.11 replaced
   * varnames/freevars/cellvars with localsplusnames/localspluskinds and
   * added qualname + exceptiontable. firstlineno is a raw int32, not an
   * object. Marshal omits nlocals (it equals len(varnames)).
   */
  private codeObject(depth: number): PythonCodeObject {
    const argCount = this.int32();
    if (this.major === 3 && this.minor >= 8) this.int32(); // posonlyargcount
    if (this.major === 3) this.int32(); // kwonlyargcount
    this.int32(); // stacksize
    this.int32(); // flags
    this.value(depth + 1); // codestring (bytes)
    const consts = this.value(depth + 1);
    const names = this.value(depth + 1);
    if (this.major === 3 && this.minor >= 11) {
      this.value(depth + 1); // localsplusnames
      this.value(depth + 1); // localspluskinds
    } else {
      this.value(depth + 1); // varnames
      this.value(depth + 1); // freevars
      this.value(depth + 1); // cellvars
    }
    const filename = this.value(depth + 1);
    const name = this.value(depth + 1);
    if (this.major === 3 && this.minor >= 11) this.value(depth + 1); // qualname
    const firstLine = this.int32();
    this.value(depth + 1); // linetable / lnotab
    if (this.major === 3 && this.minor >= 11) this.value(depth + 1); // exceptiontable
    const constList = Array.isArray(consts) ? consts : [];
    const nested: PythonCodeObject[] = [];
    const constStrings: string[] = [];
    for (const item of constList) {
      if (typeof item === "string") constStrings.push(item);
      else if (isCodeObjectLike(item)) nested.push(item);
    }
    return {
      name: typeof name === "string" ? name : "?",
      filename: typeof filename === "string" ? filename : "?",
      firstLine,
      argCount,
      names: (Array.isArray(names) ? names : []).filter(
        (entry): entry is string => typeof entry === "string",
      ),
      constStrings,
      nestedCodeObjects: nested,
    };
  }
}

const isCodeObjectLike = (value: unknown): value is PythonCodeObject =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  "nestedCodeObjects" in value;

/** Parse a .pyc file into its code-object inventory. */
export const parsePythonBytecode = (buffer: Buffer): PythonBytecodeReport => {
  const limitations: string[] = [];
  if (buffer.length < 16)
    return {
      magic: 0,
      version: null,
      topLevel: null,
      limitations: ["File too short for a .pyc header."],
    };
  // .pyc magic is two bytes plus CR LF: mask off the trailing 0x0A0D.
  const magic = buffer.readUInt32LE(0) & 0xffff;
  const version = MAGIC_VERSIONS[magic] ?? null;
  if (version === null)
    limitations.push(
      `Unknown magic ${magic}; version-specific code-object fields may differ.`,
    );
  const major =
    version === null ? 0 : Number.parseInt(version.split(".")[0] ?? "0", 10);
  const minor =
    version === null ? 0 : Number.parseInt(version.split(".")[1] ?? "0", 10);
  // 3.7+ header: magic + bit_field + timestamp + source size = 16 bytes.
  // 3.3-3.6: magic + timestamp + source size = 12 bytes. Older: 8 bytes.
  const headerSize = major >= 3 && minor >= 7 ? 16 : major >= 3 ? 12 : 8;
  const reader = new MarshalReader(buffer.subarray(headerSize), major, minor);
  try {
    const topLevel = reader.value(0);
    if (!isCodeObjectLike(topLevel))
      return {
        magic,
        version,
        topLevel: null,
        limitations: [
          ...limitations,
          "Top-level marshal value is not a code object.",
        ],
      };
    return { magic, version, topLevel, limitations };
  } catch (error) {
    limitations.push(
      `Code-object inventory stopped early: ${error instanceof Error ? error.message : "parse error"}.`,
    );
    return { magic, version, topLevel: null, limitations };
  }
};
