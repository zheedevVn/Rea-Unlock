import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("static callee boundary matching", () => {
  it("matches complete callee members without suffix collisions", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      win.loadFile("./window.html");
      BrowserWindow.loadURL("https://app.example.test");
      navigator.serviceWorker.register("./worker.js");
      loadFile("./bare.html");
      win?.loadURL("https://optional.example.test");

      uploadFile("./upload.html");
      preloadFile("./preload.html");
      downloadURL("https://download.example.test");
      reloadURL("https://reload.example.test");
      notloadURL("https://other.example.test");
      myserviceWorker.register("./not-worker.js");
    `);

    expect(
      analysis.role_paths.map(({ path, mechanism }) => [path, mechanism]),
    ).toEqual([
      ["./window.html", "call:win.loadFile"],
      ["https://app.example.test", "call:BrowserWindow.loadURL"],
      ["./bare.html", "call:loadFile"],
      ["https://optional.example.test", "call:win.loadURL"],
    ]);
    // The document base URL is unknown, so the script path stays unresolved.
    expect(
      analysis.references
        .filter(({ kind }) => kind === "service-worker")
        .map(({ specifier, expression }) => [specifier, expression]),
    ).toEqual([[null, 'navigator.serviceWorker.register("./worker.js")']]);
    expect(
      analysis.endpoints
        .filter(({ mechanism }) => mechanism.endsWith("loadURL"))
        .map(({ value }) => value),
    ).toEqual(["https://app.example.test", "https://optional.example.test"]);
  });
});
