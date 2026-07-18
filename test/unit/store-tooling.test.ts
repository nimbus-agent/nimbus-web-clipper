import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("store publishing tooling", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  test("pins the store CLIs as devDependencies (not runtime deps)", () => {
    const dev = pkg.devDependencies ?? {};
    const runtime = pkg.dependencies ?? {};
    expect(dev["chrome-webstore-upload-cli"]).toBeDefined();
    expect(dev["web-ext"]).toBeDefined();
    // The shipped extension has no runtime deps — these must not leak into `dependencies`.
    expect(runtime["chrome-webstore-upload-cli"]).toBeUndefined();
    expect(runtime["web-ext"]).toBeUndefined();
  });
});
