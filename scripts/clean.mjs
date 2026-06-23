#!/usr/bin/env node
// Remove build output produced by `bun run build` (esbuild.mjs): the whole
// dist/ tree (dist/chrome, dist/firefox) plus any packaged zips. Source is
// never touched. Safe to run when targets are already absent (force: true).
import { rmSync } from "node:fs";

const targets = ["dist", "dist-zip"];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
}

console.log(`clean: removed ${targets.join(", ")}`);
