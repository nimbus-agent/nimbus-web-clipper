#!/usr/bin/env node
// Guard the build invariant: each browser target under dist/ is a complete,
// dev-loadable MV3 extension. Run after `bun run build`; CI runs it on push/PR.
//
// Checks, per target (chrome, firefox):
//   1. Every entry in REQUIRED_FILES below exists — the manifest, one bundle per
//      esbuild entry point, the HTML+CSS of each page surface, and the three icon
//      sizes. Deliberately not restated as a count in prose: this comment said
//      "3 bundles" long after there were nine, and the array is the only thing
//      actually checked.
//   2. manifest.json is valid JSON, manifest_version 3, with a non-empty version.
//   3. The background key matches the target: Chrome uses `service_worker`,
//      Firefox uses `background.scripts` AND carries the Gecko add-on id.
//
// REQUIRED_FILES is hand-written and must stay in step with `ENTRIES` and
// `HTML_CSS` in esbuild.mjs. An entry added there but not here produces a bundle
// nothing guards, and check-build still prints OK — the silent direction, and the
// one that ships. `test/unit/build-artifacts.test.ts` fails on it.
import { existsSync, readFileSync } from "node:fs";

const TARGETS = ["chrome", "firefox"];
const REQUIRED_FILES = [
  "manifest.json",
  "background.js",
  "capture.js",
  "panel.js",
  "toast.js",
  "cue.js",
  "popup.js",
  "popup.html",
  "popup.css",
  "options.js",
  "options.html",
  "options.css",
  "brief.js",
  "brief.html",
  "brief.css",
  "ledger.js",
  "ledger.html",
  "ledger.css",
  "icons/icon-16.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
];

const failures = [];

for (const target of TARGETS) {
  const dir = `dist/${target}`;

  for (const file of REQUIRED_FILES) {
    if (!existsSync(`${dir}/${file}`)) {
      failures.push(`${target}: missing ${file} (did you run \`bun run build\`?)`);
    }
  }

  // `@nimbus-dev/sdk` must stay `import type`-only (see src/shared/findings.ts's
  // header comment): a value import would put SDK runtime code into the shipped
  // bundle. Nothing else enforces this — Biome's `useImportType` is not
  // configured here, and esbuild does not typecheck.
  //
  // This reads esbuild's own metafile (`metafile: true` in esbuild.mjs, written
  // to `dist/<target>/meta.json`) and asserts none of its `inputs` resolved to a
  // path under `node_modules/@nimbus-dev`. That inspects what esbuild actually
  // pulled into the bundle, not the output text: `esbuild.mjs` builds with
  // `bundle: true` and `format: "iife"`, which INLINES a dependency's code
  // without necessarily preserving its package specifier as a string anywhere
  // in the minified output — so grepping the built JS for "nimbus-dev" would
  // not reliably catch a value import once esbuild renamed/minified past it.
  const metaPath = `${dir}/meta.json`;
  if (!existsSync(metaPath)) {
    failures.push(`${target}: missing meta.json (did you run \`bun run build\`?)`);
  } else {
    let metafile;
    try {
      metafile = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch (err) {
      failures.push(`${target}: meta.json is not valid JSON (${err.message})`);
    }
    if (metafile !== undefined) {
      const sdkInputs = Object.keys(metafile.inputs ?? {}).filter((input) =>
        input.includes("node_modules/@nimbus-dev"),
      );
      if (sdkInputs.length > 0) {
        failures.push(
          `${target}: bundle pulled in @nimbus-dev/sdk at runtime (${sdkInputs.join(", ")}) — it must stay import-type-only`,
        );
      }
    }
  }

  const manifestPath = `${dir}/manifest.json`;
  if (!existsSync(manifestPath)) {
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    failures.push(`${target}: manifest.json is not valid JSON (${err.message})`);
    continue;
  }

  if (manifest.manifest_version !== 3) {
    failures.push(`${target}: manifest_version must be 3, got ${manifest.manifest_version}`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    failures.push(`${target}: manifest.version must be a non-empty string`);
  }

  if (target === "chrome") {
    if (manifest.background?.service_worker !== "background.js") {
      failures.push('chrome: background.service_worker must be "background.js"');
    }
    if (manifest.browser_specific_settings !== undefined) {
      failures.push("chrome: browser_specific_settings must be absent (Gecko-only)");
    }
  } else {
    if (!Array.isArray(manifest.background?.scripts)) {
      failures.push("firefox: background.scripts must be an array");
    }
    if (typeof manifest.browser_specific_settings?.gecko?.id !== "string") {
      failures.push("firefox: browser_specific_settings.gecko.id is required");
    }
  }
}

if (failures.length > 0) {
  console.error("check-build: FAILED");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`check-build: OK — ${TARGETS.join(" + ")} targets are complete MV3 extensions`);
