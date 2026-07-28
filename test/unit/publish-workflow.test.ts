import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = (): string => readFileSync(resolve(ROOT, ".github/workflows/publish.yml"), "utf8");
const credentialCheck = (): string =>
  readFileSync(resolve(ROOT, ".github/workflows/store-credential-check.yml"), "utf8");

/** Job headers (`  <name>:` at two-space indent) mapped to that job's YAML block. */
const jobBlocks = (wf: string): Map<string, string> => {
  const blocks = new Map<string, string>();
  const headers = [...wf.matchAll(/^ {2}([a-z0-9-]+):$/gm)];
  for (const [i, header] of headers.entries()) {
    const start = header.index ?? 0;
    const end = headers[i + 1]?.index ?? wf.length;
    blocks.set(header[1] as string, wf.slice(start, end));
  }
  return blocks;
};

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

  // Listed review is human-gated and takes days; web-ext's default is a 15-minute
  // poll, so without this the job goes red on every release despite a successful
  // submission. Regression guard: dropping the flag reintroduces that false failure.
  test("does not block CI on AMO's human review", () => {
    expect(workflow()).toContain("--approval-timeout 0");
  });

  test("has_amo gates on the COMPLETE AMO credential set", () => {
    const wf = workflow();
    for (const secret of ["AMO_JWT_ISSUER", "AMO_JWT_SECRET"]) {
      expect(wf).toContain(`${secret}: \${{ secrets.${secret} }}`);
      expect(wf).toContain(`[ -n "$${secret}" ]`);
    }
  });
});

// The store credentials are environment-scoped so they are not readable by every
// job in the repo. A job that reads one WITHOUT declaring `environment: release`
// resolves it to the empty string once the secrets move off repo scope — which
// fails silently (has_cws/has_amo go false and the store jobs skip), so guard it.
describe("publish credentials are environment-scoped", () => {
  const STORE_SECRET = /secrets\.(CWS|AMO)_/;

  test("every publish.yml job reading a store secret declares environment: release", () => {
    const blocks = jobBlocks(workflow());
    const readers = [...blocks].filter(([, body]) => STORE_SECRET.test(body));

    // Guards the guard: if the job-parsing regex ever stops matching, this fails
    // rather than vacuously passing over an empty set.
    expect(readers.map(([name]) => name).sort()).toEqual([
      "publish",
      "store-chrome",
      "store-firefox",
    ]);
    for (const [name, body] of readers) {
      expect(`${name}: ${body}`).toContain("environment: release");
    }
  });

  test("the credential-check job declares environment: release", () => {
    const wf = credentialCheck();
    expect(STORE_SECRET.test(wf)).toBe(true);
    expect(wf).toContain("environment: release");
  });
});
