/** Framework detection from bundle/source markers. */

export interface DetectedFramework {
  readonly name: string;
  readonly kind: "frontend" | "backend";
  readonly confidence: "high" | "medium" | "low";
  readonly evidence: string;
}

interface FrameworkMarker {
  readonly name: string;
  readonly kind: "frontend" | "backend";
  /** Distinctive markers: one match is enough for high confidence. */
  readonly distinctive: readonly RegExp[];
  /** Generic markers: need two distinct matches for high confidence. */
  readonly generic: readonly RegExp[];
}

const MARKERS: readonly FrameworkMarker[] = [
  {
    name: "React",
    kind: "frontend",
    distinctive: [
      /react-dom/i,
      /__REACT_DEVTOOLS_GLOBAL_HOOK__/i,
      /createRoot\s*\(/i,
    ],
    generic: [
      /from\s+['"]react['"]/i,
      /require\(\s*['"]react['"]\)/i,
      /jsx-runtime/i,
    ],
  },
  {
    name: "Vue",
    kind: "frontend",
    distinctive: [/__VUE__/i, /createApp\s*\(\s*\{/i, /vue\.global/i],
    generic: [/from\s+['"]vue['"]/i, /Vue\.createApp/i, /vue-router/i],
  },
  {
    name: "Angular",
    kind: "frontend",
    distinctive: [/@angular\/core/i, /ng-version/i, /platformBrowserDynamic/i],
    generic: [/__ngContext__/i, /ngZone/i],
  },
  {
    name: "Svelte",
    kind: "frontend",
    distinctive: [/create_fragment/i, /svelte\/internal/i, /\$\$\.fragment/i],
    generic: [/from\s+['"]svelte['"]/i],
  },
  {
    name: "Next.js",
    kind: "frontend",
    distinctive: [/__NEXT_DATA__/i, /\/_next\/static/i, /next\/link/i],
    generic: [/from\s+['"]next['"]/i, /NextResponse/i],
  },
  {
    name: "Nuxt",
    kind: "frontend",
    distinctive: [/__NUXT__/i, /\/_nuxt\//i],
    generic: [/from\s+['"]nuxt['"]/i, /defineNuxtConfig/i],
  },
  {
    name: "Tailwind CSS",
    kind: "frontend",
    distinctive: [
      /tailwind\.config/i,
      /@tailwind\s+(base|components|utilities)/i,
    ],
    generic: [/tailwindcss/i],
  },
  {
    name: "jQuery",
    kind: "frontend",
    distinctive: [/jQuery\.fn\.jquery/i, /jQuery v\d/i],
    generic: [/\$\.ajax\s*\(/i, /jQuery\(/i],
  },
  {
    name: "NestJS",
    kind: "backend",
    distinctive: [/@nestjs\/common/i, /NestFactory\.create/i],
    generic: [/@Controller\s*\(/i, /@Injectable\s*\(/i],
  },
  {
    name: "Express",
    kind: "backend",
    distinctive: [/require\(\s*['"]express['"]\)/i, /from\s+['"]express['"]/i],
    generic: [
      /express\.json\s*\(/i,
      /express\.Router\s*\(/i,
      /\.listen\s*\(\s*\d+\s*\)/i,
    ],
  },
  {
    name: "FastAPI",
    kind: "backend",
    distinctive: [/from\s+fastapi\s+import/i, /FastAPI\s*\(/i],
    generic: [/@app\.(get|post|put|delete)\s*\(/i],
  },
  {
    name: "Flask",
    kind: "backend",
    distinctive: [/from\s+flask\s+import/i, /Flask\s*\(\s*__name__\s*\)/i],
    generic: [/@app\.route\s*\(/i],
  },
  {
    name: "Django",
    kind: "backend",
    distinctive: [/from\s+django/i, /django\.setup\s*\(/i, /urlpatterns\s*=/i],
    generic: [/from\s+django\.urls\s+import/i],
  },
  {
    name: "Laravel",
    kind: "backend",
    distinctive: [/Illuminate\\/i, /artisan/i, /Route::(get|post)\s*\(/i],
    generic: [/\$app->/i],
  },
  {
    name: "Spring Boot",
    kind: "backend",
    distinctive: [/@SpringBootApplication/i, /org\.springframework\.boot/i],
    generic: [/@RestController/i, /@RequestMapping/i],
  },
  {
    name: "Ruby on Rails",
    kind: "backend",
    distinctive: [/Rails\.application/i, /ActionController::Base/i],
    generic: [/resources\s+:/i],
  },
];

/** Detect frameworks from text content (bundle, source, or HTML). */
export const detectFrameworks = (text: string): DetectedFramework[] => {
  const found: DetectedFramework[] = [];
  for (const marker of MARKERS) {
    let evidence = "";
    for (const pattern of marker.distinctive) {
      const match = pattern.exec(text);
      if (match !== null) {
        evidence = match[0].slice(0, 120);
        found.push({
          name: marker.name,
          kind: marker.kind,
          confidence: "high",
          evidence,
        });
        break;
      }
    }
    if (evidence !== "") continue;
    const matched: string[] = [];
    for (const pattern of marker.generic) {
      const match = pattern.exec(text);
      if (match !== null) matched.push(match[0].slice(0, 120));
    }
    if (matched.length >= 2)
      found.push({
        name: marker.name,
        kind: marker.kind,
        confidence: "high",
        evidence: matched[0] ?? "",
      });
    else if (matched.length === 1)
      found.push({
        name: marker.name,
        kind: marker.kind,
        confidence: "medium",
        evidence: matched[0] ?? "",
      });
  }
  return found;
};
