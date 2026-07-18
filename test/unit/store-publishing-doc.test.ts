import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Every CWS_ / AMO_ repository secret the publish workflow actually reads.
function workflowStoreSecrets(): string[] {
  const wf = readFileSync(resolve(ROOT, ".github/workflows/publish.yml"), "utf8");
  const names = new Set<string>();
  for (const match of wf.matchAll(/secrets\.((?:CWS|AMO)_[A-Z_]+)/g)) {
    names.add(match[1] as string);
  }
  return [...names];
}

describe("store/publishing.md", () => {
  const md = readFileSync(resolve(ROOT, "store/publishing.md"), "utf8");

  test("documents every store secret the workflow reads", () => {
    const secrets = workflowStoreSecrets();
    // Guard against a silently-empty extraction (e.g. a workflow rename).
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(md).toContain(secret);
    }
  });

  test("covers the one-time bootstrap and the steady-state tag release", () => {
    expect(md).toMatch(/first (manual )?submission/i);
    expect(md).toContain("git push");
  });
});
