#!/usr/bin/env node
// Stamp one version across the whole repo: the npm package, the Electron app and
// both lockfiles. There is a single repo version — the CLI, the SEA binary and
// the installer are always released together under one tag.
//
// CI runs this with the pushed tag (.github/workflows/release.yml) so artifacts
// can never drift from the release; locally it's `npm run version:set 0.4.0`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const requested = process.argv[2];
if (!requested) {
  console.error("usage: node scripts/set-version.mjs <X.Y.Z | vX.Y.Z>");
  process.exit(1);
}

const version = requested.replace(/^v/, "");
// electron-builder and npm both need plain semver; reject tags like "v1.0" or
// "release-3" here rather than producing a mis-named installer.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[set-version] "${requested}" is not a semver version (X.Y.Z or X.Y.Z-prerelease)`);
  process.exit(1);
}

// Each file's version fields, as key paths. In app/package-lock.json the ""
// entry is the app itself and ".." is the file:.. link to the repo root.
const targets = [
  ["package.json", [["version"]]],
  ["package-lock.json", [["version"], ["packages", "", "version"]]],
  ["app/package.json", [["version"]]],
  ["app/package-lock.json", [["version"], ["packages", "", "version"], ["packages", "..", "version"]]],
];

for (const [file, paths] of targets) {
  const path = join(root, file);
  const json = JSON.parse(readFileSync(path, "utf8"));
  for (const keys of paths) {
    const parent = keys.slice(0, -1).reduce((node, key) => node?.[key], json);
    if (!parent) continue; // entry absent (e.g. lockfile regenerated differently) — nothing to stamp
    parent[keys.at(-1)] = version;
  }
  // npm's own format: 2-space indent, trailing newline — keeps the diff minimal.
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`[set-version] ${file} → ${version}`);
}
