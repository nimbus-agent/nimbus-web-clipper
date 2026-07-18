import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SECRETS = [
  "CWS_EXTENSION_ID",
  "CWS_CLIENT_ID",
  "CWS_CLIENT_SECRET",
  "CWS_REFRESH_TOKEN",
  "AMO_JWT_ISSUER",
  "AMO_JWT_SECRET",
];

describe("store/publishing.md", () => {
  const md = readFileSync(resolve(ROOT, "store/publishing.md"), "utf8");

  test("documents every repository secret the workflow reads", () => {
    for (const secret of SECRETS) {
      expect(md).toContain(secret);
    }
  });

  test("covers the one-time bootstrap and the steady-state tag release", () => {
    expect(md).toMatch(/first (manual )?submission/i);
    expect(md).toContain("git push");
  });
});
