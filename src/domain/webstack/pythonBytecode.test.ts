import { describe, expect, it } from "vitest";

import { parsePythonBytecode } from "./pythonBytecode.js";

/** Build a minimal CPython 3.8 .pyc for <module> with one string constant. */
const buildPyc = (): Buffer => {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(16);
  header.writeUInt16LE(3413, 0); // 3.8 magic
  header.writeUInt16LE(0x0a0d, 2); // CR LF
  parts.push(header);
  const push = (chunk: Buffer): void => {
    parts.push(chunk);
  };
  const u32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32LE(value, 0);
    return buffer;
  };
  const str = (value: string): Buffer => {
    const body = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from("u"), u32(body.length), body]);
  };
  const bytes = (body: Buffer): Buffer =>
    Buffer.concat([Buffer.from("s"), u32(body.length), body]);
  const tuple = (items: Buffer[]): Buffer =>
    Buffer.concat([Buffer.from("("), u32(items.length), ...items]);
  push(Buffer.from("c"));
  push(u32(0)); // argcount
  push(u32(0)); // posonlyargcount (3.8+)
  push(u32(0)); // kwonlyargcount
  // No nlocals field in marshal: it equals len(varnames).
  push(u32(1)); // stacksize
  push(u32(0)); // flags
  push(bytes(Buffer.from([0x64, 0x00, 0x53, 0x00]))); // codestring
  push(tuple([str("hello")])); // consts
  push(tuple([str("print")])); // names
  push(tuple([])); // varnames (3.8 layout)
  push(tuple([])); // freevars
  push(tuple([])); // cellvars
  push(str("test.py")); // filename
  push(str("<module>")); // name
  push(u32(1)); // firstlineno (raw int32, no type byte)
  push(bytes(Buffer.alloc(0))); // linetable
  return Buffer.concat(parts);
};

/** Real CPython 3.12 .pyc for `MSG = "hello"\nprint(MSG)\n` (producer golden). */
const GOLDEN_PYC_312_HEX =
  "cb0d0d0a000000000000000000000000e30000000000000000000000000300000000000000f318000000970064005a00020065016500ab01000000000000010079012902da0568656c6c6f4e2902da034d5347da057072696e74a900f300000000fa09676f6c64656e2e7079fa083c6d6f64756c653e7208000000010000007311000000f003010101d8060d8003d900058063850a7206000000";

describe("parsePythonBytecode", () => {
  it("parses a real CPython 3.12 .pyc golden", () => {
    const report = parsePythonBytecode(Buffer.from(GOLDEN_PYC_312_HEX, "hex"));
    expect(report.magic).toBe(3531);
    expect(report.version).toBe("3.12");
    expect(report.topLevel?.name).toBe("<module>");
    expect(report.topLevel?.filename).toBe("golden.py");
    expect(report.topLevel?.firstLine).toBe(1);
    expect(report.topLevel?.names).toEqual(["MSG", "print"]);
    expect(report.topLevel?.constStrings).toEqual(["hello"]);
    expect(report.limitations).toEqual([]);
  });

  it("reads magic, version, and the top-level code object", () => {
    const report = parsePythonBytecode(buildPyc());
    expect(report.magic).toBe(3413);
    expect(report.version).toBe("3.8");
    expect(report.topLevel?.name).toBe("<module>");
    expect(report.topLevel?.filename).toBe("test.py");
    expect(report.topLevel?.firstLine).toBe(1);
    expect(report.topLevel?.names).toEqual(["print"]);
    expect(report.topLevel?.constStrings).toEqual(["hello"]);
    expect(report.limitations).toEqual([]);
  });

  it("reports a limitation for a truncated file", () => {
    const report = parsePythonBytecode(Buffer.from("tiny"));
    expect(report.topLevel).toBeNull();
    expect(report.limitations.length).toBeGreaterThan(0);
  });

  it("reports unknown magic without crashing", () => {
    const buffer = Buffer.alloc(32);
    buffer.writeUInt32LE(999_999, 0);
    const report = parsePythonBytecode(buffer);
    expect(report.version).toBeNull();
    expect(
      report.limitations.some((entry) => entry.includes("Unknown magic")),
    ).toBe(true);
  });
});
