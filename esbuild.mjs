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
  { in: "src/capture/toast-in-page.ts", out: "toast" },
  { in: "src/panel/cue-in-page.ts", out: "cue" },
  { in: "src/brief/brief.ts", out: "brief" },
  { in: "src/ledger/ledger.ts", out: "ledger" },
];

// Static assets copied verbatim into each target dir.
const HTML_CSS = [
  "src/popup/popup.html",
  "src/popup/popup.css",
  "src/options/options.html",
  "src/options/options.css",
  "src/brief/brief.html",
  "src/brief/brief.css",
  "src/ledger/ledger.html",
  "src/ledger/ledger.css",
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
    // Consumed by scripts/check-build.mjs to assert no bundle actually pulled
    // in @nimbus-dev/sdk's runtime code — see the comment there for why the
    // metafile's `inputs`, not the bundle text, is what that check reads.
    metafile: true,
  };
}

// Written into dist/<target>/ (git-ignored, alongside the bundles it describes)
// so scripts/check-build.mjs can inspect what esbuild actually pulled into each
// target's bundles, not just what the minified output text happens to contain.
function writeMetafile(target, metafile) {
  writeFileSync(`dist/${target}/meta.json`, JSON.stringify(metafile));
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
    const result = await build(jsOptions(target));
    writeMetafile(target, result.metafile);
    copyAssets(target);
  }
  process.stdout.write(
    `esbuild: built ${BROWSER_TARGETS.join(" + ")} (minify=${!isDev}, sourcemaps=${isDev})\n`,
  );
}

async function runWatch() {
  for (const target of BROWSER_TARGETS) {
    const ctx = await context(jsOptions(target));
    // One eager rebuild so a metafile exists from the start (watch mode's own
    // rebuilds on file changes do not re-run this write) — good enough for dev
    // reload; check-build's own runs go through runBuild above.
    const result = await ctx.rebuild();
    writeMetafile(target, result.metafile);
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
