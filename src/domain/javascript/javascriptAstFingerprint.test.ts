import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

import { fingerprintJavaScriptAst } from "./javascriptAstFingerprint.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("JavaScript AST fingerprints", () => {
  it("includes complete literal values in the fingerprint", () => {
    const prefix = "x".repeat(1_024);
    const left = parse(`const value = ${JSON.stringify(`${prefix}left`)};`);
    const right = parse(`const value = ${JSON.stringify(`${prefix}right`)};`);

    expect(fingerprintJavaScriptAst(left)).not.toBe(
      fingerprintJavaScriptAst(right),
    );
  });
});

it.each(["obj[key]", "obj?.[key]"])(
  "ignores a local computed key binding in %s",
  (expression) => {
    const left = parse(`function read(obj, key) { return ${expression}; }`);
    const renamed = expression
      .replace("obj", "value")
      .replace("key", "selector");
    const right = parse(
      `function read(value, selector) { return ${renamed}; }`,
    );
    expect(fingerprintJavaScriptAst(left)).toBe(
      fingerprintJavaScriptAst(right),
    );
  },
);

it("distinguishes computed reads from fixed named members", () => {
  expect(fingerprintJavaScriptAst(parse("obj[key]"))).not.toBe(
    fingerprintJavaScriptAst(parse("obj.key")),
  );
  expect(fingerprintJavaScriptAst(parse("obj.key"))).not.toBe(
    fingerprintJavaScriptAst(parse("obj.other")),
  );
  expect(fingerprintJavaScriptAst(parse('obj["key"]'))).not.toBe(
    fingerprintJavaScriptAst(parse('obj["other"]')),
  );
});

it.each([
  ["obj[`left`]", "obj[`right`]"],
  ["obj[``]", "obj[`right`]"],
  ["obj[true]", "obj[false]"],
  ["obj[null]", "obj[false]"],
  ['obj["" ]', 'obj["right"]'],
  ["obj[`prefix-${key}`]", "obj[`changed-${key}`]"],
])("retains computed literal contents in %s", (left, right) => {
  expect(fingerprintJavaScriptAst(parse(left))).not.toBe(
    fingerprintJavaScriptAst(parse(right)),
  );
});

it("keeps renamed computed-key bundle modules structurally matchable", () => {
  const source = (name: string) => `globalThis.webpackChunkApp.push([[1], {
    17(module, exports) { const ${name} = selectKey(); exports.read = value[${name}]; }
  }]);`;
  const before = analyzeJavaScriptStaticSource(source("key"))
    .bundler_registrations[0]?.modules[0];
  const after = analyzeJavaScriptStaticSource(source("selector"))
    .bundler_registrations[0]?.modules[0];
  expect(before).toBeDefined();
  expect(after).toBeDefined();
  expect(before?.structural_fingerprint_algorithm).toBe("babel-ast-v2");
  expect(before?.source_sha256).not.toBe(after?.source_sha256);
  expect(before?.structural_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(before?.structural_fingerprint_sha256).toBe(
    after?.structural_fingerprint_sha256,
  );
});
