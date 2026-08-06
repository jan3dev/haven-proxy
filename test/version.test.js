// Tests the version plumbing — `npm test`. The release pipeline stamps one
// version across package.json / app/package.json (scripts/set-version.mjs) and
// the installer name plus `--version` are derived from it, so a drift here means
// a mis-labelled release. No network, no filesystem writes.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readPkg = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const cli = (...args) => execFileSync(process.execPath, [join(root, "src", "index.js"), ...args], { encoding: "utf8" });

describe("version", () => {
  test("VERSION mirrors package.json", () => {
    assert.equal(VERSION, readPkg("package.json").version);
  });

  test("the Electron app ships the same version (installer name derives from it)", () => {
    assert.equal(readPkg("app/package.json").version, VERSION);
  });

  test("--version, -v and `version` all print it", () => {
    for (const arg of ["--version", "-v", "version"]) {
      assert.equal(cli(arg), `haven-proxy ${VERSION}\n`);
    }
  });

  test("help header carries the version", () => {
    assert.match(cli("help"), new RegExp(`^haven-proxy ${VERSION.replace(/\./g, "\\.")} —`));
  });
});
