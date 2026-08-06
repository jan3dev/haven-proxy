// The package version, for `haven-proxy --version` and the help header.
//
// Read from package.json so there's one source of truth (scripts/set-version.mjs
// stamps it from the release tag). The JSON import is also what bakes the version
// into the SEA binary: esbuild inlines it at build time, so the bundled
// executable doesn't need a package.json on disk.
import pkg from "../package.json" with { type: "json" };

export const VERSION = pkg.version;
