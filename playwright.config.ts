import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';

// --- Runtime modes ---
// RUN_MODE=LOCAL   -> Start Astro dev server (local development)
// RUN_MODE=BUILD   -> Build Astro site and serve from "dist" (CI / closest to production)
// RUN_MODE=REMOTE  -> Do not start any local server, test directly against remote URL
const RUN_MODE = process.env.RUN_MODE ?? (process.env.CI ? 'BUILD' : 'LOCAL');
const SKIP_BUILD = String(process.env.SKIP_BUILD ?? '').length > 0; // any truthy value skips build
const DIST_EXISTS = fs.existsSync('dist');

// Allow overriding test directory via environment variable (default: ./tests)
const testDir = process.env.TEST_DIR ?? './test';

// Base URL changes depending on the mode
// LOCAL -> http://localhost:4321 (Astro dev server)
// BUILD -> http://localhost:4173 (served "dist")
// REMOTE -> PROD_BASE_URL (falls back to p5js.org)
const baseURL =
  RUN_MODE === 'LOCAL'
    ? 'http://localhost:4321'
    : RUN_MODE === 'BUILD'
    ? 'http://localhost:4173'
    : process.env.PROD_BASE_URL ?? 'https://p5js.org';


export default defineConfig({
  // Use dynamic testDir (default ./tests)
  testDir,
  outputDir: 'test-results',
  // Global timeout for each test to improve stability
  timeout: 30 * 1000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Retry failed tests in CI
  retries: process.env.CI ? 2 : 0,
  // Force single worker in CI to avoid port/resource conflicts
  workers: process.env.CI ? 1 : undefined,
  // Reporters: "list" for readable console logs + "html" for detailed report
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL,
    // Save trace only on first retry for debugging failed tests
    trace: 'on-first-retry',
    // Capture screenshot only on failure
    screenshot: 'only-on-failure',
    // Keep video only on failure in CI
    video: process.env.CI ? 'retain-on-failure' : 'off',
  },

  // Test projects: three major engines + iPhone 15 viewport
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

  // Start appropriate webServer depending on the mode
  webServer:
    RUN_MODE === 'LOCAL'
      ? {
          // Start Astro dev server for local development
          command: 'npm run dev',
            port: 4321,
          reuseExistingServer: !process.env.CI,
          timeout: 600_000,
        }
      : RUN_MODE === 'BUILD'
      ? {
        // Allow skipping the build step if dist/ already exists or SKIP_BUILD is set
        command: (SKIP_BUILD || DIST_EXISTS)
          ? 'npm run preview -- --port 4173 --host'
          : 'npm run build && npm run preview -- --port 4173 --host',
        port: 4173, // choose port OR url (not both)
        reuseExistingServer: !process.env.CI,
        timeout: 600_000,
      }
      : undefined, // REMOTE mode → no server started
});
