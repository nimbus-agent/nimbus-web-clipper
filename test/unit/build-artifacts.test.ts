import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * `esbuild.mjs`'s `ENTRIES` / `HTML_CSS` and `scripts/check-build.mjs`'s
 * `REQUIRED_FILES` are two hand-written lists of the same artifact set, and only
 * one of the two directions of drift fails loudly.
 *
 * Adding an entry point to the build without adding its output to
 * `REQUIRED_FILES` ships a bundle nothing guards — and `bun run check-build`
 * still prints OK, because it only asserts that the files it knows about exist.
 * The reverse (a required file with no producer) already fails the build gate on
 * the first run. So this test exists for the silent direction.
 *
 * It reads both files as TEXT rather than importing them: `esbuild.mjs` runs the
 * build as a top-level side effect, so importing it here would rebuild `dist/`
 * inside the unit suite.
 */

const readSource = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

/** The `out` names in esbuild.mjs's `ENTRIES` — each becomes `dist/<target>/<out>.js`. */
function esbuildEntryOutputs(): string[] {
  const src = readSource("esbuild.mjs");
  const block = /const ENTRIES = \[([\s\S]*?)\n\];/.exec(src);
  if (block === null) {
    throw new Error("esbuild.mjs: could not find the ENTRIES array — has it been renamed?");
  }
  return [...(block[1] as string).matchAll(/out:\s*"([^"]+)"/g)].map((m) => `${m[1]}.js`);
}

/** The static assets esbuild.mjs copies, flattened to their basenames as `copyAssets` does. */
function esbuildStaticAssets(): string[] {
  const src = readSource("esbuild.mjs");
  const block = /const HTML_CSS = \[([\s\S]*?)\n\];/.exec(src);
  if (block === null) {
    throw new Error("esbuild.mjs: could not find the HTML_CSS array — has it been renamed?");
  }
  return [...(block[1] as string).matchAll(/"([^"]+)"/g)].map(
    (m) => (m[1] as string).split("/").pop() as string,
  );
}

function requiredFiles(): string[] {
  const src = readSource("scripts/check-build.mjs");
  const block = /const REQUIRED_FILES = \[([\s\S]*?)\n\];/.exec(src);
  if (block === null) {
    throw new Error("check-build.mjs: could not find REQUIRED_FILES — has it been renamed?");
  }
  return [...(block[1] as string).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

describe("check-build guards everything the build produces", () => {
  // Guards the guards: every extractor below is a regex over source text, and a
  // rename would make each of them return nothing — which would make the parity
  // assertions pass vacuously over two empty sets.
  test("each list parses to a non-empty set", () => {
    expect(esbuildEntryOutputs().length).toBeGreaterThan(0);
    expect(esbuildStaticAssets().length).toBeGreaterThan(0);
    expect(requiredFiles().length).toBeGreaterThan(0);
  });

  test("every esbuild entry point has its bundle in REQUIRED_FILES", () => {
    const required = new Set(requiredFiles());
    const unguarded = esbuildEntryOutputs().filter((out) => !required.has(out));
    expect(unguarded).toEqual([]);
  });

  test("every copied HTML/CSS asset is in REQUIRED_FILES", () => {
    const required = new Set(requiredFiles());
    const unguarded = esbuildStaticAssets().filter((name) => !required.has(name));
    expect(unguarded).toEqual([]);
  });

  test("REQUIRED_FILES names no .js the build does not produce", () => {
    // The loud direction, asserted anyway: it fails `check-build` only when
    // someone actually runs a build, and a stale entry there reads as a real
    // artifact to anyone auditing the guard.
    const produced = new Set(esbuildEntryOutputs());
    const orphans = requiredFiles().filter((f) => f.endsWith(".js") && !produced.has(f));
    expect(orphans).toEqual([]);
  });
});
