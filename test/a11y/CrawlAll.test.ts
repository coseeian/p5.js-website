import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";

/**
 * Discover all built routes by scanning the Astro `dist` folder for `index.html` files
 * and convert them to URL paths (e.g. dist/reference/index.html -> /reference/).
 */
const getAllRoutesFromDist = (distRoot: string): string[] => {
  const routes: string[] = [];

  const walk = (dir: string, relDir = "") => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile() && entry.name === "index.html") {
        const routeDir = path.dirname(rel);
        // Normalize to URL path with trailing slash
        const route = routeDir === "." ? "/" : `/${routeDir.replace(/\\/g, "/")}/`;
        routes.push(route);
      }
    }
  };

  if (fs.existsSync(distRoot)) walk(distRoot, "");
  return Array.from(new Set(routes)).sort();
};

const RUN_MODE = process.env.RUN_MODE ?? (process.env.CI ? "BUILD" : "LOCAL");

// This suite requires a built site so we can read routes from `dist`.
test.describe("a11y-crawl-all", () => {
  test.skip(
    RUN_MODE !== "BUILD",
    "Route crawling requires RUN_MODE=BUILD (uses dist/).",
  );

  const distRoot = path.resolve(process.cwd(), "dist");
  const allRoutes = getAllRoutesFromDist(distRoot);

  // Optional filters to speed up or target specific locales in CI/local runs
  const onlyLocale = process.env.A11Y_LOCALE; // e.g., "es" to test only /es/... routes
  const maxPages = Number(process.env.A11Y_MAX_PAGES || 0); // limit number of pages
  const routePrefixRaw =
    process.env.A11Y_ROUTE_PREFIX ||
    process.env.A11Y_PREFIX ||
    process.env.A11Y_ROUTE_STARTS_WITH ||
    "";

  const normalizePrefix = (p: string): string | null => {
    const s = (p || "").trim();
    if (!s) return null;
    let out = s.startsWith("/") ? s : `/${s}`;
    // collapse repeated slashes and ensure trailing slash (except root)
    out = out.replace(/\/{2,}/g, "/");
    if (out !== "/" && !out.endsWith("/")) out += "/";
    return out;
  };
  const routePrefix = normalizePrefix(routePrefixRaw);

  const filtered = allRoutes.filter((r) => {
    if (!onlyLocale) return true;
    // Default locale (en) has no prefix; allow "/" and non-prefixed when A11Y_LOCALE=en
    if (onlyLocale === "en") return !/^\/[a-z]{2}(-[A-Za-z]+)?\//.test(r) || r === "/";
    return r.startsWith(`/${onlyLocale}/`);
  });

  const filteredByPrefix = routePrefix ? filtered.filter((r) => r.startsWith(routePrefix)) : filtered;

  const targetRoutes = maxPages > 0 ? filteredByPrefix.slice(0, maxPages) : filteredByPrefix;

  // --- Per-run timestamped output directory (YYYY-MM-DD-HH-mm-ss) ---
  const pad = (n: number) => String(n).padStart(2, '0');
  const formatTs = (d = new Date()) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const RUN_TS = formatTs();
  const outRoot = path.resolve(process.cwd(), "test-results", "a11y", "report");
  const runDir = path.join(outRoot, RUN_TS);

  test("sanity: found routes to test", () => {
    expect(targetRoutes.length).toBeGreaterThan(0);
  });

  for (const route of targetRoutes) {
    test(`should have no detectable a11y issues: ${route}`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      const results = await new AxeBuilder({ page }).analyze();
      const violations = results.violations ?? [];

      // If violations exist, write them to a JSON file whose name is derived from the route
      if (violations.length > 0) {
        const outDir = runDir;

        // Derive locale folder: prefer explicit A11Y_LOCALE, otherwise parse from route
        const explicitLocale = process.env.A11Y_LOCALE;
        const parsedFirstSeg = (() => {
          const seg = route.split('/').filter(Boolean)[0] || '';
          // heuristic: xx or xx-YY style codes → treat as locale
          if (/^[a-z]{2}(?:-[A-Za-z0-9]+)?$/.test(seg)) return seg;
          return 'en';
        })();
        const localeFolder = (explicitLocale && explicitLocale.length > 0) ? explicitLocale : parsedFirstSeg;

        // Derive device folder from Playwright project name, e.g. "Desktop Chrome", "iPhone 15"
        // This ensures per-device outputs do not overwrite each other.
        const projectName = test.info().project.name || "unknown-device";
        const deviceFolder = projectName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'unknown-device';

        const outDirPerLocale = path.join(outDir, localeFolder, deviceFolder);
        try {
          fs.mkdirSync(outDirPerLocale, { recursive: true });
        } catch {}

        // Convert route to a safe file name: remove leading/trailing slashes
        // and replace remaining non-filename characters with underscores.
        const safeName = route === "/"
          ? "root"
          : route.replace(/^\/+|\/+$/g, "").replace(/[^\w.-]+/g, "_");
        const outPath = path.join(outDirPerLocale, `${safeName}.json`);
        try {
          // Store as an object with the route for easier aggregation downstream
          fs.writeFileSync(
            outPath,
            JSON.stringify({ route, device: projectName, violations }, null, 2),
            "utf8",
          );
        } catch {}
      }

      expect(violations).toEqual([]);
    });
  }

  async function page2file(): Promise<void> {
    const outDir = runDir; // limit aggregation to this run's folder
    try {
      if (!fs.existsSync(outDir)) return;
      // Limit aggregation strictly to routes tested in this run
      const targetRouteSet = new Set(targetRoutes);
      // Recursively walk a11y output dir to find page JSONs
      const foundFiles: string[] = [];
      const walk = (dir: string, rel = '') => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) walk(abs, path.join(rel, e.name));
          else if (e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('_')) foundFiles.push(abs);
        }
      };
      walk(outDir);

      const summary = [] as Array<{
        file: string;
        route: string;
        device?: string;
        count: number;
        ids: string[];
      }>;
      for (const absFile of foundFiles) {
        try {
          const raw = fs.readFileSync(absFile, 'utf8');
          const data = JSON.parse(raw);
          const violations = Array.isArray(data) ? data : (data?.violations ?? []);
          if (!Array.isArray(violations) || violations.length === 0) continue;
          const route = typeof data?.route === 'string' && data.route ? data.route : undefined;
          const file = path.relative(outDir, absFile).replace(/\\/g, '/');
          // Try to infer device from path: <locale>/<device>/<page>.json
          const segs = file.split('/');
          const inferredDevice = segs.length >= 3 ? segs[1] : undefined;
          // Fallback route guess from file name if not embedded
          const base = path.basename(absFile).replace(/\.json$/i, '');
          const routeGuess = base === 'root' ? '/' : `/${base.replace(/_/g, '/')}/`;
          const effectiveRoute = route ?? routeGuess;
          // Skip stale files from previous runs that don't belong to this run's target routes
          if (!targetRouteSet.has(effectiveRoute)) continue;
          summary.push({
            file,
            route: effectiveRoute,
            device: typeof data?.device === 'string' ? data.device : inferredDevice,
            count: violations.length,
            ids: violations.map((v: any) => v?.id).filter(Boolean),
          });
        } catch {}
      }
      // Always write an aggregate summary across all devices
      const localeTag = (process.env.A11Y_LOCALE ?? 'all').replace(/[^A-Za-z0-9_.-]/g, '_');
      const outAllFile = `_summary.${localeTag}.all-devices.json`;
      const outAllPath = path.join(outDir, outAllFile);
      fs.writeFileSync(
        outAllPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            locale: process.env.A11Y_LOCALE ?? null,
            device: 'all-devices',
            pagesTested: targetRoutes.length,
            pagesWithViolations: summary.length,
            details: summary,
          },
          null,
          2,
        ),
        'utf8',
      );

      // Additionally, write per-device summaries by grouping by inferred/embedded device
      const byDevice = new Map<string, typeof summary>();
      for (const item of summary) {
        const key = (item.device ?? 'unknown-device').toString();
        if (!byDevice.has(key)) byDevice.set(key, []);
        byDevice.get(key)!.push(item);
      }
      for (const [deviceKey, items] of byDevice) {
        const deviceTag = deviceKey.replace(/[^A-Za-z0-9_.-]/g, '_');
        const outDevFile = `_summary.${localeTag}.${deviceTag}.json`;
        const outDevPath = path.join(outDir, outDevFile);
        fs.writeFileSync(
          outDevPath,
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              locale: process.env.A11Y_LOCALE ?? null,
              device: deviceKey,
              pagesTested: targetRoutes.length,
              pagesWithViolations: items.length,
              details: items,
            },
            null,
            2,
          ),
          'utf8',
        );
      }

      // ID-centric summary across all devices: group violation id -> routes[]
      const idMap = new Map<string, Set<string>>();
      for (const item of summary) {
        const route = item.route;
        for (const id of item.ids) {
          if (!idMap.has(id)) idMap.set(id, new Set());
          idMap.get(id)!.add(route);
        }
      }
      const idDetails = Array.from(idMap.entries())
        .map(([id, routes]) => ({ id, count: routes.size, routes: Array.from(routes).sort() }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const outIdsFile = `_summary.ids.${localeTag}.all-devices.json`;
      const outIdsPath = path.join(outDir, outIdsFile);
      fs.writeFileSync(
        outIdsPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            locale: process.env.A11Y_LOCALE ?? null,
            device: 'all-devices',
            uniqueIds: idDetails.length,
            details: idDetails,
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {}
  };

  test.afterAll(page2file);
});
