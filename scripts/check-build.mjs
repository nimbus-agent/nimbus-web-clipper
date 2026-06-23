#!/usr/bin/env node
// Guard the build invariant: each browser target under dist/ is a complete,
// dev-loadable MV3 extension. Run after `bun run build`; CI runs it on push/PR.
//
// Checks, per target (chrome, firefox):
//   1. Every required artifact exists (manifest + 3 bundles + popup/options
//      HTML+CSS + the three icon sizes).
//   2. manifest.json is valid JSON, manifest_version 3, with a non-empty version.
//   3. The background key matches the target: Chrome uses `service_worker`,
//      Firefox uses `background.scripts` AND carries the Gecko add-on id.
import { existsSync, readFileSync } from "node:fs";

const TARGETS = ["chrome", "firefox"];
const REQUIRED_FILES = [
  "manifest.json",
  "background.js",
  "capture.js",
  "popup.js",
  "popup.html",
  "popup.css",
  "options.js",
  "options.html",
  "options.css",
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
      failures.push("chrome: background.service_worker must be \"background.js\"");
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
