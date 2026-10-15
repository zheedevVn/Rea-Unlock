import { describe, expect, it } from "vitest";

import { extractApiRoutes } from "./apiRoutes.js";

describe("extractApiRoutes", () => {
  it("extracts Express routes", () => {
    const routes = extractApiRoutes(
      "server.js",
      `const app = express();\napp.get('/users', handler);\nrouter.post("/login", handler);\n`,
    );
    expect(routes).toContainEqual({
      method: "GET",
      path: "/users",
      framework: "express",
      file: "server.js",
      line: 2,
    });
    expect(routes).toContainEqual({
      method: "POST",
      path: "/login",
      framework: "express",
      file: "server.js",
      line: 3,
    });
  });

  it("extracts Flask routes with method lists", () => {
    const routes = extractApiRoutes(
      "app.py",
      `@app.route('/items', methods=['GET', 'POST'])\ndef items(): pass\n@app.get('/health')\ndef health(): pass\n`,
    );
    expect(routes).toContainEqual({
      method: "GET",
      path: "/items",
      framework: "flask-fastapi",
      file: "app.py",
      line: 1,
    });
    expect(routes).toContainEqual({
      method: "POST",
      path: "/items",
      framework: "flask-fastapi",
      file: "app.py",
      line: 1,
    });
    expect(routes).toContainEqual({
      method: "GET",
      path: "/health",
      framework: "flask-fastapi",
      file: "app.py",
      line: 3,
    });
  });

  it("extracts Django paths and normalizes them", () => {
    const routes = extractApiRoutes(
      "urls.py",
      `urlpatterns = [path('users/', views.users), re_path(r'^api/(?P<id>\\d+)/$', views.detail)]\n`,
    );
    expect(routes).toContainEqual({
      method: "ANY",
      path: "/users/",
      framework: "django",
      file: "urls.py",
      line: 1,
    });
    expect(routes).toContainEqual({
      method: "ANY",
      path: "/api/(?P<id>\\d+)/",
      framework: "django",
      file: "urls.py",
      line: 1,
    });
  });

  it("extracts Go handlers with methods", () => {
    const routes = extractApiRoutes(
      "main.go",
      `r.GET("/ping", h)\nhttp.HandleFunc("/root", h)\n`,
    );
    expect(routes).toContainEqual({
      method: "GET",
      path: "/ping",
      framework: "go",
      file: "main.go",
      line: 1,
    });
    expect(routes).toContainEqual({
      method: "ANY",
      path: "/root",
      framework: "go",
      file: "main.go",
      line: 2,
    });
  });

  it("derives Next.js App Router paths from the file location", () => {
    const routes = extractApiRoutes(
      "/project/app/api/users/[id]/route.ts",
      `export async function GET() { return Response.json({}); }\n`,
    );
    expect(routes).toContainEqual({
      method: "GET",
      path: "/api/users/:id",
      framework: "nextjs",
      file: "/project/app/api/users/[id]/route.ts",
      line: 1,
    });
  });
});
