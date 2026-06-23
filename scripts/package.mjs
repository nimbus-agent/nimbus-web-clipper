#!/usr/bin/env node
// Zip each built target into dist-zip/nimbus-web-clipper-<target>-<version>.zip
// for sideloading / store submission. Run after `bun run build`.
//
// Uses the system `zip` on POSIX and PowerShell's Compress-Archive on Windows so
// it works on a developer machine and on the Linux CI runner alike.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
const TARGETS = ["chrome", "firefox"];

mkdirSync("dist-zip", { recursive: true });

for (const target of TARGETS) {
  const srcDir = `dist/${target}`;
  if (!existsSync(srcDir)) {
    console.error(`package: ${srcDir} not found — run \`bun run build\` first`);
    process.exit(1);
  }
  const outName = `nimbus-web-clipper-${target}-${version}.zip`;
  const outPath = resolve("dist-zip", outName);
  rmSync(outPath, { force: true });

  if (platform() === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${resolve(srcDir)}/*' -DestinationPath '${outPath}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } else {
    // `zip -r` from inside the target dir so paths are relative to the extension root.
    execFileSync("zip", ["-r", "-q", outPath, "."], { cwd: srcDir, stdio: "inherit" });
  }
  console.log(`package: wrote dist-zip/${outName}`);
}
