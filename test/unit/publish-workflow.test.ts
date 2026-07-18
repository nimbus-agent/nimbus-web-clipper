import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = (): string => readFileSync(resolve(ROOT, ".github/workflows/publish.yml"), "utf8");

describe("publish workflow — publish job", () => {
  test("exposes version + store-secret-presence outputs", () => {
    const wf = workflow();
    expect(wf).toContain("version: ${{ steps.version.outputs.version }}");
    expect(wf).toContain("has_cws: ${{ steps.store_flags.outputs.has_cws }}");
    expect(wf).toContain("has_amo: ${{ steps.store_flags.outputs.has_amo }}");
  });

  test("lints the Firefox bundle with addons-linter before release", () => {
    expect(workflow()).toContain("bunx web-ext lint --source-dir dist/firefox");
  });

  test("builds the AMO source archive from tracked files", () => {
    expect(workflow()).toContain("git archive --format=zip");
  });

  test("uploads the build as an artifact for the store jobs", () => {
    const wf = workflow();
    expect(wf).toContain("actions/upload-artifact@");
    expect(wf).toContain("name: extension-build");
  });
});

describe("publish workflow — store-chrome job", () => {
  test("runs after publish, gated on CWS secrets", () => {
    const wf = workflow();
    expect(wf).toContain("store-chrome:");
    expect(wf).toContain("if: needs.publish.outputs.has_cws == 'true'");
  });

  test("uploads + publishes via the chrome-webstore-upload CLI", () => {
    const wf = workflow();
    expect(wf).toContain("actions/download-artifact@");
    expect(wf).toContain("bunx chrome-webstore-upload");
    expect(wf).toContain("--extension-id");
  });
});
