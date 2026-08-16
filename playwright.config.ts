import { defineConfig } from "@playwright/test";

// The suites drive a real Chromium with the built extension loaded, so they are
// deliberately serial-per-file and modest on workers: each spec owns a browser
// context and a mock gateway on its own ephemeral port.
export default defineConfig({
  testDir: "test/e2e",
  testMatch: /.*\.e2e\.ts/,
  // Retries exist for infrastructure flake (a slow worker registration), never
  // as a way to live with a nondeterministic assertion. A test that needs the
  // retry to pass is deleted, not tolerated.
  retries: process.env["CI"] === undefined ? 0 : 1,
  timeout: 30_000,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: { trace: "retain-on-failure" },
});
