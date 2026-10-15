import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const endpoints = (source: string) =>
  analyzeJavaScriptStaticSource(source).endpoints.map(
    ({ kind, value, mechanism }) => ({ kind, value, mechanism }),
  );

describe("beacon endpoints", () => {
  it("reports navigator.sendBeacon URLs", () => {
    expect(
      endpoints(`
        navigator.sendBeacon("/api/telemetry", payload);
        window.navigator.sendBeacon("https://metrics.example/collect");
      `),
    ).toEqual([
      {
        kind: "network",
        value: "/api/telemetry",
        mechanism: "call:navigator.sendBeacon",
      },
      {
        kind: "network",
        value: "https://metrics.example/collect",
        mechanism: "call:window.navigator.sendBeacon",
      },
    ]);
  });

  it("keeps a dynamic beacon URL unreported", () => {
    expect(endpoints("navigator.sendBeacon(url, payload);")).toEqual([]);
  });
});
