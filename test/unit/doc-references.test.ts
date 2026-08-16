import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * `CLAUDE.md` records the convention: per-feature design specs live in
 * `docs/superpowers/specs/`, and "plans and review notes are pruned once a feature ships
 * and live on in git history". Pruning is therefore routine — which is exactly why a
 * reference to a pruned file can rot silently. `ROADMAP.md`, `docs/architecture.md` and
 * source comments all cite specs by path, and 19 files were pruned in the change that
 * added this test.
 *
 * The sibling gateway repo has an `audit:doc-refs` gate for the same reason. This is the
 * cheap version: no new script, no new CI wiring — it rides the existing suite.
 */

/**
 * Deliberately-dangling references: a path cited to say the document is GONE.
 *
 * `ROADMAP.md` cites the browser-gateway-client design spec precisely to explain that it
 * "was written and merged in the gateway repo — then pruned from that repo once the
 * feature it specified shipped", and that the briefs beneath it, "not that now-pruned
 * document, are the current authority". The citation is the point; resolving it is not.
 *
 * Add to this list only when the SURROUNDING PROSE tells the reader the file is gone.
 * A reference that merely happens to be broken belongs in the failure list, not here.
 */
const INTENTIONALLY_PRUNED = new Set<string>([
  "docs/superpowers/specs/2026-08-01-browser-gateway-client-design.md",
]);

/** Files that cite specs: the roadmap, the architecture reference, and source comments. */
function filesThatCiteSpecs(): string[] {
  const out: string[] = [resolve(ROOT, "ROADMAP.md")];
  const docsDir = resolve(ROOT, "docs");
  for (const entry of readdirSync(docsDir)) {
    if (entry.endsWith(".md")) out.push(join(docsDir, entry));
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(resolve(ROOT, "src"));
  return out.filter((f) => existsSync(f));
}

const SPEC_REF = /docs\/superpowers\/[a-z]+\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md/g;

describe("references to docs/superpowers resolve", () => {
  test("every cited spec exists, unless it is a documented pruned-doc citation", () => {
    const broken: string[] = [];
    for (const file of filesThatCiteSpecs()) {
      const src = readFileSync(file, "utf8");
      for (const match of src.matchAll(SPEC_REF)) {
        const ref = match[0];
        if (INTENTIONALLY_PRUNED.has(ref)) continue;
        if (!existsSync(resolve(ROOT, ref))) {
          broken.push(`${file.slice(ROOT.length + 1)} -> ${ref}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("the pruned-doc allowlist does not accumulate entries that now resolve", () => {
    // If a listed file comes back, the allowlist entry stops being a statement about
    // history and starts hiding a real reference — so it must be removed.
    const resurrected = [...INTENTIONALLY_PRUNED].filter((ref) => existsSync(resolve(ROOT, ref)));
    expect(resurrected).toEqual([]);
  });

  test("plans are pruned, per the convention CLAUDE.md states", () => {
    // Not a style rule — `docs/superpowers/plans/` being empty is what the convention
    // means in practice, and a stray plan is the signal that a feature shipped without
    // its cleanup.
    const plansDir = resolve(ROOT, "docs/superpowers/plans");
    const leftovers = existsSync(plansDir)
      ? readdirSync(plansDir).filter((f) => f.endsWith(".md"))
      : [];
    expect(leftovers).toEqual([]);
  });
});
