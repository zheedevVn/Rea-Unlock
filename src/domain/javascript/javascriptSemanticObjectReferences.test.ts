import * as t from "@babel/types";
import { expect, it } from "vitest";

import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import { semanticObjectPropertyReferences } from "./javascriptSemanticObjectReferences.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const objectAndState = (source: string) => {
  const parsed = parseJavaScriptSource(source, "object.js");
  if (parsed === null) throw new Error("Expected a parsed fixture");
  const declaration = parsed.program.body[0];
  if (!t.isVariableDeclaration(declaration))
    throw new Error("Expected a declaration");
  const init = declaration.declarations[0]?.init;
  if (!t.isObjectExpression(init)) throw new Error("Expected an object");
  return {
    object: init,
    source,
    state: completeSemanticSteps(indexJavaScriptBindingsSteps(parsed.program)),
  };
};

const spelled = (
  fixture: ReturnType<typeof objectAndState>,
  key: string | number | null,
) =>
  semanticObjectPropertyReferences(fixture.object, [key], fixture.state).map(
    ({ node, path }) => [
      fixture.source.slice(node.start ?? 0, node.end ?? 0),
      JSON.stringify(path),
    ],
  );

it("resolves exact keys with source-order overrides, spreads and accessors", () => {
  const fixture = objectAndState(
    `const o = { a: 1, ...base, b: 2, a: 3, [dynamic]: 4, __proto__: proto, ...{ b: 5 }, get c() { return 6; }, c: 7 };`,
  );
  // Expectations match the full source-order scan these exact keys replace.
  expect(spelled(fixture, "a")).toEqual([
    ["{ b: 5 }", '["a"]'],
    ["4", "[]"],
    ["3", "[]"],
  ]);
  expect(spelled(fixture, "b")).toEqual([
    ["{ b: 5 }", '["b"]'],
    ["4", "[]"],
  ]);
  expect(spelled(fixture, "c")).toEqual([
    ["7", "[]"],
    ["4", "[]"],
  ]);
  expect(spelled(fixture, "missing")).toEqual([
    ["{ b: 5 }", '["missing"]'],
    ["proto", '["missing"]'],
    ["4", "[]"],
    ["base", '["missing"]'],
  ]);
  // A wildcard key still scans every property.
  expect(spelled(fixture, null)).toEqual([
    ["7", "[]"],
    ["{ b: 5 }", '[{"excludedKeys":["c"]}]'],
    ["proto", "[null]"],
    ["4", "[]"],
    ["3", "[]"],
    ["2", "[]"],
    ["base", '[{"excludedKeys":["a","b","c"]}]'],
  ]);
  // Numeric keys use the same exact spelling as string keys.
  expect(
    spelled(objectAndState(`const o = { 1: "one", 2: "two" };`), 1),
  ).toEqual([['"one"', "[]"]]);
});
