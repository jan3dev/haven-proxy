// Post-pack trimming and a guard, in CommonJS because the rest of app/ is ESM
// ("type": "module") and electron-builder requires hook files.
const { listPackage } = require("@electron/asar");
const { readdirSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");

const LICENSES = "LICENSES.chromium.html";
// Sits at the packed root on win/linux but several levels into
// Electron Framework.framework on mac — search instead of hardcoding both.
const MAX_DEPTH = 6;

module.exports = async ({ appOutDir, packager }) => {
  // Chromium's bundled licence dump: 20MB of HTML the app never opens.
  // Attribution lives in the README instead.
  const removed = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.name === LICENSES) {
        unlinkSync(path);
        removed.push(path);
      }
    }
  };
  walk(appOutDir, 0);
  if (removed.length === 0) console.warn(`[after-pack] warning: no ${LICENSES} found under ${appOutDir}`);
  else for (const path of removed) console.log(`[after-pack] removed ${path}`);

  // scripts/prepack.mjs bundles every dependency into main.js, so a node_modules
  // in the package means electron-builder's module collector kicked in and
  // dereferenced the haven-proxy file:.. symlink — which drags the whole repo in
  // (SEA binary, nested builds, .env). Fail loudly rather than ship 500MB.
  const asar = join(packager.getResourcesDir(appOutDir), "app.asar");
  const leaked = listPackage(asar, {}).filter((it) => it.includes("node_modules"));
  if (leaked.length > 0) {
    throw new Error(
      `[after-pack] ${leaked.length} node_modules entries leaked into app.asar (e.g. ${leaked[0]}). ` +
        "haven-proxy must stay a devDependency in app/package.json so the collector skips it.",
    );
  }
  console.log(`[after-pack] app.asar clean: ${listPackage(asar, {}).length} entries, no node_modules`);
};
