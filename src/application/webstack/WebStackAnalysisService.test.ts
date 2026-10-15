import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

import { WebStackAnalysisService } from "./WebStackAnalysisService.js";
import { webStackReportSchema } from "../../domain/webstack/webStackReport.js";

describe("WebStackAnalysisService", () => {
  it("analyzes a directory of backend and frontend files", async () => {
    const root = await createTestTempDirectory("rea-web-stack-");
    await mkdir(join(root, "api"), { recursive: true });
    await writeFile(
      join(root, "api", "app.py"),
      `from flask import Flask\napp = Flask(__name__)\n@app.route('/items', methods=['GET'])\ndef items(): pass\n`,
    );
    await writeFile(join(root, "style.css"), ".a{color:red}.b{margin:0}");
    const service = new WebStackAnalysisService();
    const result = await service.execute("analyze_web_stack", { path: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = webStackReportSchema.safeParse(
      result.value.normalized_result,
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.files.map((file) => file.path)).toHaveLength(2);
    expect(parsed.data.routes).toContainEqual({
      method: "GET",
      path: "/items",
      framework: "flask-fastapi",
      file: join(root, "api", "app.py"),
      line: 3,
    });
    expect(parsed.data.frameworks.some((entry) => entry.name === "Flask")).toBe(
      true,
    );
    expect(result.value.subject?.format).toBe("directory");
  });

  it("rejects a relative path", async () => {
    const service = new WebStackAnalysisService();
    const result = await service.execute("analyze_web_stack", {
      path: "relative/path",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing path", async () => {
    const service = new WebStackAnalysisService();
    const result = await service.execute("analyze_web_stack", {
      path: "/definitely/not/here-rea",
    });
    expect(result.ok).toBe(false);
  });
});
