import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("store publishing tooling", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };

  test("pins the store CLIs as devDependencies (not runtime deps)", () => {
    const dev = pkg.devDependencies ?? {};
    expect(dev["chrome-webstore-upload-cli"]).toBeDefined();
    expect(dev["web-ext"]).toBeDefined();
  });
});
