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

  const filtered = allRoutes.filter((r) => {
    if (!onlyLocale) return true;
    // Default locale (en) has no prefix; allow "/" and non-prefixed when A11Y_LOCALE=en
    if (onlyLocale === "en") return !/^\/[a-z]{2}(-[A-Za-z]+)?\//.test(r) || r === "/";
    return r.startsWith(`/${onlyLocale}/`);
  });

  const targetRoutes = maxPages > 0 ? filtered.slice(0, maxPages) : filtered;

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
        const outDir = path.resolve(process.cwd(), "test-results", "a11y");

        // Derive locale folder: prefer explicit A11Y_LOCALE, otherwise parse from route
        const explicitLocale = process.env.A11Y_LOCALE;
        const parsedFirstSeg = (() => {
          const seg = route.split('/').filter(Boolean)[0] || '';
          // heuristic: xx or xx-YY style codes → treat as locale
          if (/^[a-z]{2}(?:-[A-Za-z0-9]+)?$/.test(seg)) return seg;
          return 'en';
        })();
        const localeFolder = (explicitLocale && explicitLocale.length > 0) ? explicitLocale : parsedFirstSeg;

        const outDirPerLocale = path.join(outDir, localeFolder);
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
            JSON.stringify({ route, violations }, null, 2),
            "utf8",
          );
        } catch {}
      }

      expect(violations).toEqual([]);
    });
  }

  async function page2file(): Promise<void> {
    const outDir = path.resolve(process.cwd(), "test-results", "a11y");
    try {
      if (!fs.existsSync(outDir)) return;
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

      const summary = [] as Array<{ file: string; route: string; count: number; ids: string[] }>;
      for (const absFile of foundFiles) {
        try {
          const raw = fs.readFileSync(absFile, 'utf8');
          const data = JSON.parse(raw);
          const violations = Array.isArray(data) ? data : (data?.violations ?? []);
          if (!Array.isArray(violations) || violations.length === 0) continue;
          const route = typeof data?.route === 'string' && data.route ? data.route : undefined;
          const file = path.relative(outDir, absFile).replace(/\\/g, '/');
          // Fallback route guess from file name if not embedded
          const base = path.basename(absFile).replace(/\.json$/i, '');
          const routeGuess = base === 'root' ? '/' : `/${base.replace(/_/g, '/')}/`;
          summary.push({ file, route: route ?? routeGuess, count: violations.length, ids: violations.map((v: any) => v?.id).filter(Boolean) });
        } catch {}
      }
      const localeTag = (process.env.A11Y_LOCALE ?? 'all').replace(/[^A-Za-z0-9_.-]/g, '_');
      const deviceTag = (process.env.A11Y_DEVICE ?? 'all-devices').replace(/[^A-Za-z0-9_.-]/g, '_');
      const outFile = `_summary.${localeTag}.${deviceTag}.json`;
      const outPath = path.join(outDir, outFile);
      fs.writeFileSync(
        outPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            locale: process.env.A11Y_LOCALE ?? null,
            device: process.env.A11Y_DEVICE ?? null,
            pagesTested: targetRoutes.length,
            pagesWithViolations: summary.length,
            details: summary,
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
