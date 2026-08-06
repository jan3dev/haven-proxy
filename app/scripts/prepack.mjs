#!/usr/bin/env node
// Build the directory electron-builder actually packages (app/.bundle, wired up
// via directories.app). Everything the app needs is bundled into one main.js,
// so app.asar holds four files instead of the whole dependency tree — the raw
// node_modules of haven-proxy weighed 24MB, almost all of it dead code that
// never runs in the tray app (see scripts/build-sea.mjs, which does the same
// for the CLI and lands at ~1MB).
//
// The generated dir is also a hard boundary: only what this script writes can
// end up in the package, so the repo's .env can't leak in no matter how the
// dependency graph or symlinks change.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(appDir, ".bundle");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ESM out, not CJS: main.js uses import.meta.dirname to find preload.cjs, and
// Electron loads an ESM main because package.json below stays "type": "module".
console.log("[prepack] bundling main.js");
await build({
  entryPoints: [join(appDir, "main.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: join(outDir, "main.js"),
  // electron is provided by the runtime; the two ws addons are optional native
  // ones required inside a try/catch on a path this proxy never takes (same
  // externals as the SEA build).
  external: ["electron", "bufferutil", "utf-8-validate"],
  logLevel: "warning",
});

// preload.cjs stays CommonJS and only requires electron — nothing to bundle.
for (const file of ["preload.cjs", "key-window.html"]) {
  copyFileSync(join(appDir, file), join(outDir, file));
}

// electron-builder reads the app's version/productName from here, and its own
// electron version from app/package.json. Dependencies are gone — they're in
// the bundle — which keeps electron-builder from copying node_modules back in.
const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
delete pkg.dependencies;
delete pkg.devDependencies;
delete pkg.scripts;
writeFileSync(join(outDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`[prepack] done: ${outDir}`);
