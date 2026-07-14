// Build the MV3 extension for every browser target into dist/<target>/.
//
// Run via `bun esbuild.mjs` (not node) so we can import the typed manifest
// module directly — the manifest is composed in TypeScript, see src/manifest.
// Each target dir is self-contained and dev-loadable as-is:
//   dist/chrome   → chrome://extensions → Load unpacked
//   dist/firefox  → about:debugging → Load Temporary Add-on (pick manifest.json)
//
// Production (CI/publish, NODE_ENV unset) → minified, no sourcemaps.
// `--watch` or NODE_ENV=development → unminified + sourcemaps.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build, context } from "esbuild";
import { BROWSER_TARGETS, composeManifest } from "./src/manifest/manifest.ts";

const isWatch = process.argv.includes("--watch");
const isDev = isWatch || process.env.NODE_ENV === "development";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;

// Each entry bundles to dist/<target>/<out>.js. Browser globals (chrome) are
// host-provided; the bundles import nothing at runtime (IIFE, fully inlined).
const ENTRIES = [
  { in: "src/background/service-worker.ts", out: "background" },
  { in: "src/popup/popup.ts", out: "popup" },
  { in: "src/options/options.ts", out: "options" },
  { in: "src/capture/capture-in-page.ts", out: "capture" },
  { in: "src/panel/panel-in-page.ts", out: "panel" },
];

// Static assets copied verbatim into each target dir.
const HTML_CSS = [
  "src/popup/popup.html",
  "src/popup/popup.css",
  "src/options/options.html",
  "src/options/options.css",
];

function jsOptions(target) {
  return {
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    sourcemap: isDev,
    minify: !isDev,
    treeShaking: true,
    logLevel: "info",
    entryPoints: ENTRIES.map((e) => ({ in: e.in, out: e.out })),
    outdir: `dist/${target}`,
  };
}

function copyAssets(target) {
  const dir = `dist/${target}`;
  mkdirSync(dir, { recursive: true });
  for (const asset of HTML_CSS) {
    const name = asset.split("/").pop();
    copyFileFlat(asset, `${dir}/${name}`);
  }
  cpSync("src/icons", `${dir}/icons`, { recursive: true });
  writeFileSync(
    `${dir}/manifest.json`,
    `${JSON.stringify(composeManifest(target, version), null, 2)}\n`,
  );
}

function copyFileFlat(from, to) {
  cpSync(from, to);
}

async function runBuild() {
  rmSync("dist", { recursive: true, force: true });
  for (const target of BROWSER_TARGETS) {
    await build(jsOptions(target));
    copyAssets(target);
  }
  process.stdout.write(
    `esbuild: built ${BROWSER_TARGETS.join(" + ")} (minify=${!isDev}, sourcemaps=${isDev})\n`,
  );
}

async function runWatch() {
  for (const target of BROWSER_TARGETS) {
    const ctx = await context(jsOptions(target));
    await ctx.watch();
    copyAssets(target);
  }
  process.stdout.write("esbuild: watching for changes…\n");
}

if (isWatch) {
  await runWatch();
} else {
  await runBuild();
}
