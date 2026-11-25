// Browser tests of the built web app. Locally they run against site/ (scripts/serve-site.mjs);
// E2E_BASE_URL points them at a deployed copy instead, such as the GitHub Pages site.
import { defineConfig, devices } from "@playwright/test";

const LOCAL = "http://127.0.0.1:4173/time-tracker/";
const baseURL = process.env.E2E_BASE_URL ?? LOCAL;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    // The iPhone size in WebKit, the browser engine of Safari.
    { name: "webkit-iphone", use: { ...devices["iPhone 13"] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "node scripts/serve-site.mjs 4173",
        url: LOCAL,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
