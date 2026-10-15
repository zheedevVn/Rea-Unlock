import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const responses = (source: string) =>
  analyzeJavaScriptSemantics(source)
    .requestOperations.filter(({ kind }) => kind === "response-consumer")
    .map(({ method, endpoint, resolution }) => ({
      method,
      endpoint,
      resolution,
    }));

it("keeps the endpoint of a uniquely consumed request response", () => {
  expect(
    responses(`
      async function load() {
        const a = await fetch("https://example.test/a");
        const b = await fetch("https://example.test/b");
        return [await a.json(), await b.text()];
      }
    `),
  ).toEqual([
    {
      method: "json",
      endpoint: "https://example.test/a",
      resolution: "complete",
    },
    {
      method: "text",
      endpoint: "https://example.test/b",
      resolution: "complete",
    },
  ]);
});

it("leaves an ambiguous response consumer without an endpoint", () => {
  expect(
    responses(`
      async function load(flag) {
        let response = await fetch("https://example.test/a");
        if (flag) response = await fetch("https://example.test/b");
        return response.json();
      }
    `),
  ).toEqual([{ method: "json", endpoint: null, resolution: "partial" }]);
});

it("leaves a response replaced by a non-request value without an endpoint", () => {
  expect(
    responses(`
      async function load(cachedResponse) {
        let response = await fetch("https://example.test/a");
        response = cachedResponse;
        return response.json();
      }
    `),
  ).toEqual([expect.objectContaining({ method: "json", endpoint: null })]);
});
