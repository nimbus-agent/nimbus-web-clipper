import { defineConfig } from "@playwright/test";

// The suites drive a real Chromium with the built extension loaded, so they are
// deliberately serial-per-file and modest on workers: each spec owns a browser
// context and a mock gateway on its own ephemeral port. `workers` says so
// explicitly on CI — several Chromium-with-extension instances, each with its
// own in-process mock, contending on a shared runner is exactly the kind of
// resource pressure that turns a tight assertion window into a flaky one.
// Locally, Playwright's own default (cores/2) is left alone: a developer's
// machine is not a shared, resource-capped runner.
export default defineConfig({
  testDir: "test/e2e",
  testMatch: /.*\.e2e\.ts/,
  // Retries exist for infrastructure flake (a slow worker registration), never
  // as a way to live with a nondeterministic assertion. A test that needs the
  // retry to pass is deleted, not tolerated.
  retries: process.env["CI"] === undefined ? 0 : 1,
  // Omitted rather than set to `undefined` locally: exactOptionalPropertyTypes
  // treats those as different things, and Playwright's own default (cores/2)
  // is what a local run should get.
  ...(process.env["CI"] === undefined ? {} : { workers: 1 }),
  timeout: 30_000,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: { trace: "retain-on-failure" },
});
