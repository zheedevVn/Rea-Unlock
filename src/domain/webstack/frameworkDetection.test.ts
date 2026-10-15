import { describe, expect, it } from "vitest";

import { detectFrameworks } from "./frameworkDetection.js";

describe("detectFrameworks", () => {
  it("detects React from a distinctive marker", () => {
    const found = detectFrameworks(
      `const root = createRoot(document.getElementById('app'));`,
    );
    expect(found).toContainEqual({
      name: "React",
      kind: "frontend",
      confidence: "high",
      evidence: "createRoot(",
    });
  });

  it("detects Django and Flask from imports", () => {
    const found = detectFrameworks(
      `from django.urls import path\nfrom flask import Flask\n`,
    );
    expect(found.some((entry) => entry.name === "Django")).toBe(true);
    expect(found.some((entry) => entry.name === "Flask")).toBe(true);
  });

  it("returns nothing for plain text", () => {
    expect(detectFrameworks("hello world, nothing to see here")).toEqual([]);
  });
});
