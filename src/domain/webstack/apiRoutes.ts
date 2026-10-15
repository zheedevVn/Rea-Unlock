import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";

/** Route extraction from backend/frontend source text. */

export interface ApiRoute {
  readonly method: string;
  readonly path: string;
  readonly framework: string;
  readonly file: string;
  readonly line: number;
}

const MAX_ROUTES = 500;
const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "HEAD",
  "ALL",
];

interface RoutePattern {
  readonly framework: string;
  readonly regex: RegExp;
  /** Index of the method capture group (0 = fixed method), path group, methods group. */
  readonly methodGroup: number;
  readonly pathGroup: number;
  readonly methodsGroup?: number;
  readonly fixedMethod?: string;
}

/** One framework's route shapes. Capture groups: method?, path, methods-list?. */
const PATTERNS: readonly RoutePattern[] = [
  // Express / Fastify / Koa (JS/TS): app.get('/users', ...), router.post("...", ...)
  {
    framework: "express",
    // Negative lookbehind: do not match Python decorators like @app.get(...).
    regex:
      /(?<!@)(?:app|router|server|fastify)\.(get|post|put|delete|patch|all|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    methodGroup: 1,
    pathGroup: 2,
  },
  // Next.js App Router: export async function GET/POST/PUT/DELETE(...)
  {
    framework: "nextjs",
    regex:
      /export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s*\(/gi,
    methodGroup: 1,
    pathGroup: 0,
  },
  // Flask / FastAPI (Python): @app.route('/x', methods=['GET']), @app.get('/x'), @router.post
  {
    framework: "flask-fastapi",
    regex:
      /@(?:app|router|bp|blueprint)\.(?:route\(\s*['"`]([^'"`]+)['"`]\s*(?:,[^)]*?methods\s*=\s*\[([^\]]+)\])?[^)]*\)|(get|post|put|delete|patch|options|head)\(\s*['"`]([^'"`]+)['"`])/gi,
    methodGroup: 3,
    pathGroup: 4,
    methodsGroup: 2,
  },
  // Django (Python): path('users/', view), re_path(r'^...$', view), url(...)
  {
    framework: "django",
    regex: /(?:path|re_path|url)\(\s*(?:r)?['"`]([^'"`]+)['"`]/gi,
    methodGroup: 0,
    pathGroup: 1,
    fixedMethod: "ANY",
  },
  // Laravel / Slim (PHP): Route::get('/x', ...), $app->get('/x', ...)
  {
    framework: "laravel",
    regex:
      /(?:Route::|\$app->|\$router->)(get|post|put|delete|patch|options|any)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    methodGroup: 1,
    pathGroup: 2,
  },
  // Go: http.HandleFunc("/x", ...), mux.HandleFunc, r.GET("/x", ...), e.POST(...)
  {
    framework: "go",
    regex:
      /(HandleFunc|(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD))\s*\(\s*"([^"]+)"/gi,
    methodGroup: 2,
    pathGroup: 3,
    fixedMethod: "ANY",
  },
  // Rails (Ruby): get '/x', post '/x', resources :users
  {
    framework: "rails",
    regex: /^\s*(get|post|put|delete|patch)\s+['"`]([^'"`]+)['"`]/gim,
    methodGroup: 1,
    pathGroup: 2,
  },
];

const normalizeMethod = (raw: string | undefined, fallback: string): string => {
  const upper = (raw ?? fallback).toUpperCase();
  return HTTP_METHODS.includes(upper) || upper === "ANY" ? upper : fallback;
};

const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

const unquotePath = (raw: string): string => raw.trim();

/** Extract API routes from one source file's text. */
export const extractApiRoutes = (file: string, text: string): ApiRoute[] => {
  const routes: ApiRoute[] = [];
  const seen = new Set<string>();
  const push = (route: ApiRoute): void => {
    const key = `${route.method} ${route.path} ${route.file}:${route.line}`;
    if (seen.has(key) || routes.length >= MAX_ROUTES) return;
    seen.add(key);
    routes.push(route);
  };
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (;;) {
      const match = pattern.regex.exec(text);
      if (match === null) break;
      // Next.js: the route path comes from the file location, not the code.
      if (pattern.framework === "nextjs") {
        const method = normalizeMethod(match[pattern.methodGroup], "GET");
        const routePath = nextRoutePath(file);
        if (routePath !== null)
          push({
            method,
            path: routePath,
            framework: "nextjs",
            file,
            line: lineOf(text, match.index),
          });
        continue;
      }
      // Flask route() branch: path in group 1, methods list in group 2.
      if (pattern.framework === "flask-fastapi" && match[1] !== undefined) {
        const routePath = unquotePath(match[1]);
        if (!routePath.startsWith("/")) continue;
        const methodsText = match[2] ?? "";
        const methods = methodsText.match(/['"]([A-Za-z]+)['"]/g) ?? [];
        if (methods.length === 0) {
          push({
            method: "ANY",
            path: routePath,
            framework: pattern.framework,
            file,
            line: lineOf(text, match.index),
          });
        } else {
          for (const quoted of methods)
            push({
              method: normalizeMethod(quoted.replace(/['"]/g, ""), "ANY"),
              path: routePath,
              framework: pattern.framework,
              file,
              line: lineOf(text, match.index),
            });
        }
        continue;
      }
      const rawPath = match[pattern.pathGroup];
      if (rawPath === undefined || rawPath === "") continue;
      let path = unquotePath(rawPath);
      if (pattern.framework === "django") {
        path = path.replace(/^\^/, "").replace(/\$$/, "");
        if (!path.startsWith("/")) path = `/${path}`;
      }
      if (
        !path.startsWith("/") &&
        !path.startsWith("^") &&
        pattern.framework !== "django"
      )
        continue;
      const method = normalizeMethod(
        pattern.methodGroup > 0 ? match[pattern.methodGroup] : undefined,
        pattern.fixedMethod ?? "ANY",
      );
      push({
        method,
        path,
        framework: pattern.framework,
        file,
        line: lineOf(text, match.index),
      });
    }
  }
  return routes.sort(
    (a, b) => compareUnicodeCodePoints(a.file, b.file) || a.line - b.line,
  );
};

/** Derive a Next.js App Router path from a route.ts file location. */
const nextRoutePath = (file: string): string | null => {
  const match = /\/app\/(.+?)\/route\.(?:ts|js)$/.exec(
    file.replace(/\\/g, "/"),
  );
  if (match === null) return null;
  const segments = (match[1] ?? "")
    .split("/")
    .filter((segment) => segment !== "route" && segment.length > 0)
    .map((segment) =>
      segment
        .replace(/^\[([^\]]+)\]$/, ":$1")
        .replace(/^\[\.\.\.(.+)\]$/, "*$1"),
    );
  return `/${segments.join("/")}`;
};
