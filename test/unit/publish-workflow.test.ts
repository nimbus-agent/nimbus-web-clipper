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

  test("builds the source archive after attaching the Release", () => {
    const wf = workflow();
    const attachIdx = wf.indexOf("Attach zips to the GitHub Release");
    const archiveIdx = wf.indexOf("Build source archive for AMO review");
    expect(attachIdx).toBeGreaterThan(-1);
    expect(archiveIdx).toBeGreaterThan(-1);
    expect(attachIdx).toBeLessThan(archiveIdx);
  });
});

describe("publish workflow — store-chrome job", () => {
  test("runs after publish, gated on CWS secrets", () => {
    const wf = workflow();
    expect(wf).toContain("store-chrome:");
    expect(wf).toContain("if: needs.publish.outputs.has_cws == 'true'");
    expect(wf).toContain("path: .");
  });

  test("uploads + publishes via the chrome-webstore-upload CLI", () => {
    const wf = workflow();
    expect(wf).toContain("actions/download-artifact@");
    expect(wf).toContain("bunx chrome-webstore-upload");
    expect(wf).toContain("--extension-id");
  });

  test("passes PUBLISHER_ID (required by chrome-webstore-upload-cli v4)", () => {
    expect(workflow()).toContain("PUBLISHER_ID: ${{ secrets.CWS_PUBLISHER_ID }}");
  });

  test("has_cws gates on the COMPLETE Chrome credential set", () => {
    const wf = workflow();
    for (const secret of [
      "CWS_CLIENT_ID",
      "CWS_CLIENT_SECRET",
      "CWS_REFRESH_TOKEN",
      "CWS_EXTENSION_ID",
      "CWS_PUBLISHER_ID",
    ]) {
      // each is both mapped into the detect step's env and checked in the guard
      expect(wf).toContain(`${secret}: \${{ secrets.${secret} }}`);
      expect(wf).toContain(`[ -n "$${secret}" ]`);
    }
  });
});

describe("publish workflow — store-firefox job", () => {
  test("runs after publish, gated on AMO secrets", () => {
    const wf = workflow();
    expect(wf).toContain("store-firefox:");
    expect(wf).toContain("if: needs.publish.outputs.has_amo == 'true'");
    expect(wf).toContain("path: .");
  });

  test("signs + submits a listed version with the source archive", () => {
    const wf = workflow();
    expect(wf).toContain("bunx web-ext sign");
    expect(wf).toContain("--channel listed");
    expect(wf).toContain("--upload-source-code");
  });

  test("has_amo gates on the COMPLETE AMO credential set", () => {
    const wf = workflow();
    for (const secret of ["AMO_JWT_ISSUER", "AMO_JWT_SECRET"]) {
      expect(wf).toContain(`${secret}: \${{ secrets.${secret} }}`);
      expect(wf).toContain(`[ -n "$${secret}" ]`);
    }
  });
});
