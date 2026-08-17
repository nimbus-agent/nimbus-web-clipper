import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKLIST = resolve(ROOT, "docs/development.md");
const E2E_DIR = resolve(ROOT, "test/e2e");

const MARKER = /<!--\s*e2e:([a-z0-9-]+)\s*-->/g;
// Quote-agnostic. Biome formats this repo to double quotes, so single quotes or
// backticks should never survive a commit — but if one did, a quote-specific
// regex would parse the block to nothing and report a FALSE drift failure. A
// guard that cries wolf is a guard people learn to ignore, which is the exact
// death spiral this slice exists to end.
const DECLARED = /['"`]([a-z0-9-]+)['"`]/g;

function markersInChecklist(): string[] {
  const src = readFileSync(CHECKLIST, "utf8");
  return [...src.matchAll(MARKER)].map((m) => m[1] ?? "");
}

function idsDeclaredByTests(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(E2E_DIR).filter((f) => f.endsWith(".e2e.ts"))) {
    const src = readFileSync(join(E2E_DIR, file), "utf8");
    const block = /export const COVERS = \[([^\]]*)\]/.exec(src);
    if (block?.[1] !== undefined) {
      out.push(...[...block[1].matchAll(DECLARED)].map((m) => m[1] ?? ""));
    }
  }
  return out;
}

describe("e2e coverage markers stay in step with the suite", () => {
  test("every marker in the checklist is declared by some e2e file", () => {
    const declared = new Set(idsDeclaredByTests());
    const orphaned = markersInChecklist().filter((id) => !declared.has(id));
    // A step claiming coverage that no test provides is the worse direction:
    // it reads as verified and is not.
    expect(orphaned).toEqual([]);
  });

  test("every id an e2e file declares appears in the checklist", () => {
    const markers = new Set(markersInChecklist());
    const unmarked = idsDeclaredByTests().filter((id) => !markers.has(id));
    // The other direction: a covered step still presented as manual sends a
    // human to re-do work a machine already does.
    expect(unmarked).toEqual([]);
  });

  test("marker ids are unique — a duplicate hides a gap", () => {
    const seen = markersInChecklist();
    expect(seen.length).toBe(new Set(seen).size);
  });

  test("every e2e file declares a non-empty COVERS", () => {
    // Closes the vacuous case the two directional tests cannot see. A suite
    // whose COVERS block fails to parse — or was never written — declares
    // nothing, and "nothing" is trivially consistent with a checklist that has
    // no markers for it yet. Both tests above would pass while the file's
    // coverage went unrecorded.
    const empty: string[] = [];
    for (const file of readdirSync(E2E_DIR).filter((f) => f.endsWith(".e2e.ts"))) {
      const src = readFileSync(join(E2E_DIR, file), "utf8");
      const block = /export const COVERS = \[([^\]]*)\]/.exec(src);
      if (block?.[1] === undefined || [...block[1].matchAll(DECLARED)].length === 0) {
        empty.push(file);
      }
    }
    expect(empty).toEqual([]);
  });
});
