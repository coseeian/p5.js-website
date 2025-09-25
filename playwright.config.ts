// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// --- Centralized output folders ---
const RESULTS_ROOT = 'test-results/a11y/playwright';
const RAW_DIR  = path.join(RESULTS_ROOT, 'raw');   // Screenshots / videos / traces / downloads
const HTML_DIR = path.join(RESULTS_ROOT, 'html');  // HTML test reports

// Ensure required directories exist
[RAW_DIR, HTML_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// --- Runtime modes ---
// RUN_MODE=LOCAL   -> Start Astro dev server (local development)
// RUN_MODE=BUILD   -> Build Astro site and serve from "dist" (CI / production-like)
// RUN_MODE=REMOTE  -> Do not start local server, run tests against remote PROD_BASE_URL
const RUN_MODE = process.env.RUN_MODE ?? (process.env.CI ? 'BUILD' : 'LOCAL');
const SKIP_BUILD = String(process.env.SKIP_BUILD ?? '').length > 0;
const DIST_EXISTS = fs.existsSync('dist');

// Allow overriding test directory via environment variable (default: ./test)
const testDir = process.env.TEST_DIR ?? './test';

// Base URL depending on mode
// LOCAL -> http://localhost:4321
// BUILD -> http://localhost:4173
// REMOTE -> PROD_BASE_URL or fallback https://p5js.org
const baseURL =
  RUN_MODE === 'LOCAL'
    ? 'http://localhost:4321'
    : RUN_MODE === 'BUILD'
    ? 'http://localhost:4173'
    : process.env.PROD_BASE_URL ?? 'https://p5js.org';

export default defineConfig({
  testDir,
  // Store raw artifacts (screenshots, videos, traces, downloads) in RAW_DIR
  outputDir: RAW_DIR,
  timeout: 30 * 1000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  // Reporters: console list + HTML report + JSON report
  reporter: [
    ['list'],
    ['html', { outputFolder: HTML_DIR, open: 'never' }],
  ],

  use: {
    baseURL,
    trace: 'on-first-retry',          // Collect trace only on first retry
    screenshot: 'only-on-failure',    // Capture screenshots only on failures
    video: process.env.CI ? 'retain-on-failure' : 'off', // Keep videos only in CI and only on failure
  },

  // Test projects: major desktop browsers + iPhone 15 + Pixel 7
  projects: (() => {
    const all = [
      { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } },
      { name: 'Desktop Firefox',  use: { ...devices['Desktop Firefox'] } },
      { name: 'Desktop Safari',   use: { ...devices['Desktop Safari'] } },
      { name: 'iPhone 15', use: { ...devices['iPhone 15'] } },
      { name: 'Pixel 7', use: { ...devices['Pixel 7'] } },
    ];
    const pick = process.env.A11Y_DEVICE;
    if (pick) {
      const filtered = all.filter(p => p.name.toLowerCase() === pick.toLowerCase());
      return filtered.length ? filtered : all.filter(p => p.name === 'Desktop Chrome');
    }
    return all;
  })(),

  // Start appropriate server depending on mode
  webServer:
    RUN_MODE === 'LOCAL'
      ? {
          command: 'npm run dev',
          port: 4321,
          reuseExistingServer: !process.env.CI,
          timeout: 600_000,
        }
      : RUN_MODE === 'BUILD'
      ? {
          command: (SKIP_BUILD || DIST_EXISTS)
            ? 'npm run preview -- --port 4173 --host'
            : 'npm run build && npm run preview -- --port 4173 --host',
          port: 4173,
          reuseExistingServer: !process.env.CI,
          timeout: 600_000,
        }
      : undefined, // REMOTE mode → no local server
});
