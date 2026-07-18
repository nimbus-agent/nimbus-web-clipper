import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { composeManifest } from "../../src/manifest/manifest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Extract the back-ticked keys from the `## Permission justifications` section. */
function justifiedPermissions(md: string): Set<string> {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s+Permission justifications\s*$/.test(l));
  if (start === -1) {
    throw new Error("store/listing.md: missing '## Permission justifications' heading");
  }
  const keys = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) {
      break; // next section
    }
    const key = line.match(/^-\s+`([^`]+)`\s*:/)?.[1];
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

describe("store/listing.md ↔ manifest permission parity", () => {
  test("justifies exactly the manifest permissions plus the host_permissions group", () => {
    const md = readFileSync(resolve(ROOT, "store/listing.md"), "utf8");
    const justified = justifiedPermissions(md);
    const manifest = composeManifest("chrome", "0.0.0");
    // Host access is justified as ONE group under the literal `host_permissions`
    // key (the Chrome Web Store's model), not enumerated per URL pattern — so we
    // expect the four API permissions plus the single "host_permissions" token.
    expect(manifest.host_permissions.length).toBeGreaterThan(0);
    const expected = new Set<string>([...manifest.permissions, "host_permissions"]);
    expect(justified).toEqual(expected);
  });
});
