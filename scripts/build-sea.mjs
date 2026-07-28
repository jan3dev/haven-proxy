#!/usr/bin/env node
// Build a standalone single-file executable of the haven-proxy CLI using
// Node's Single Executable Application (SEA) support:
//   1. esbuild bundles src/index.js (+ all deps) into one CommonJS file
//      (SEA main scripts must be CJS).
//   2. `node --check` gates the bundle: top-level await is a syntax error in
//      CJS, so a dep upgrade that introduces it fails the build here instead
//      of at users' runtime.
//   3. `node --experimental-sea-config` produces the injectable blob.
//   4. The running node binary is copied, its code signature stripped
//      (postject refuses/corrupts signed binaries), and the blob injected.
//
// Runs on win32/darwin/linux — SEA cannot cross-compile, so each OS builds
// its own binary (CI does this via a runner matrix).
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const bundlePath = join(dist, "haven-proxy.cjs");
const blobPath = join(dist, "sea-prep.blob");
const seaConfigPath = join(dist, "sea-config.json");
const exePath = join(dist, process.platform === "win32" ? "haven-proxy.exe" : "haven-proxy");

mkdirSync(dist, { recursive: true });

// --- 1. Bundle to a single CJS file ---
console.log("[build-sea] bundling src/index.js → dist/haven-proxy.cjs");
await build({
  entryPoints: [join(root, "src", "index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: bundlePath,
  // ws's optional native addons — required inside try/catch on a realtime
  // code path this proxy never executes; the catch falls back to pure JS.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "warning",
});

// --- 2. Gate: no top-level await survived the CJS conversion ---
execFileSync(process.execPath, ["--check", bundlePath], { stdio: "inherit" });

// --- 3. Generate the SEA blob ---
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useCodeCache: true,
      useSnapshot: false,
    },
    null,
    2,
  ),
);
console.log("[build-sea] generating SEA blob");
execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

// --- 4. Copy the node binary and strip its code signature ---
console.log(`[build-sea] copying ${process.execPath} → ${exePath}`);
copyFileSync(process.execPath, exePath);

if (process.platform === "win32") {
  const signtool = findSigntool();
  if (signtool) {
    try {
      execFileSync(signtool, ["remove", "/s", exePath], { stdio: "inherit" });
    } catch {
      console.warn("[build-sea] warning: signtool remove failed — continuing (signature may end up invalid)");
    }
  } else {
    console.warn("[build-sea] warning: signtool.exe not found — injecting into a signed node.exe (signature will be invalid)");
  }
} else if (process.platform === "darwin") {
  execFileSync("codesign", ["--remove-signature", exePath], { stdio: "inherit" });
}

// --- 5. Inject the blob ---
console.log("[build-sea] injecting SEA blob");
await inject(exePath, "NODE_SEA_BLOB", readFileSync(blobPath), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" && { machoSegmentName: "NODE_SEA" }),
});

if (process.platform === "darwin") {
  // Apple Silicon refuses to run unsigned binaries — ad-hoc sign.
  execFileSync("codesign", ["--sign", "-", exePath], { stdio: "inherit" });
}
if (process.platform !== "win32") chmodSync(exePath, 0o755);

console.log(`[build-sea] done: ${exePath}`);

// signtool.exe ships with the Windows SDK, not on PATH — glob the usual spot.
function findSigntool() {
  const kitsBin = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (!existsSync(kitsBin)) return null;
  const versions = readdirSync(kitsBin)
    .filter((d) => /^10\.\d+/.test(d))
    .sort()
    .reverse();
  for (const v of versions) {
    const candidate = join(kitsBin, v, "x64", "signtool.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
