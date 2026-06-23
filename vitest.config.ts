import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    // Default environment is node; DOM-touching tests (popup/options) opt into
    // jsdom via a `// @vitest-environment jsdom` docblock at the top of the file.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      // No hard thresholds here: coverage quality is enforced by SonarCloud's
      // "Sonar way" gate (80% on NEW code) via sonar.yml. `test:coverage` only
      // generates the lcov report the Sonar scan consumes.
    },
  },
});
