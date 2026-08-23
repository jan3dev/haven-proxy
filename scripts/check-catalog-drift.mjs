// Detect drift between the bootstrap catalog (MODELS in src/defaults.js) and
// what the backends actually serve. Run locally or from CI:
//   node scripts/check-catalog-drift.mjs
//
// It goes through the real fetchCatalog parser on purpose: a backend schema
// change that breaks the product's parsing also fails this check. /pricing/ is
// world-readable, so no API key is involved. Exit codes: 0 clean, 1 drift found
// or the authoritative backend unreachable.
import { fetchCatalog } from "../src/relay.js";
import { MODEL_IDS } from "../src/defaults.js";

const BACKENDS = [
  // Prod is authoritative: the bootstrap list must match it. Staging previews
  // what is coming, so its findings are reported the same way.
  { label: "prod", origin: "https://ankara.aquabtc.com", authoritative: true },
  { label: "stg", origin: "https://test.aquabtc.com", authoritative: false },
];

const findings = [];
const report = (line) => {
  findings.push(line);
  console.log(`DRIFT  ${line}`);
};

for (const { label, origin, authoritative } of BACKENDS) {
  const root = `${origin}/api/v1/haven`;
  console.log(`\n== ${label}: ${root}/pricing/`);
  const fetched = await fetchCatalog(root);
  if (!fetched.ok) {
    const line = `${label}: catalog fetch failed (${fetched.reason})`;
    // A down staging backend is noise; an unreachable prod means we checked nothing.
    if (authoritative) report(line);
    else console.log(`WARN   ${line}`);
    continue;
  }

  const served = fetched.models;
  const servedIds = new Set(served.map((m) => m.id));
  console.log(`served: ${[...servedIds].sort().join(", ")}`);

  for (const row of served) {
    if (!MODEL_IDS.includes(row.id)) {
      report(`${label}: "${row.id}" is served but missing from MODELS in src/defaults.js`);
    }
    if (row.status === "deprecated" || row.sunset_on) {
      report(
        `${label}: "${row.id}" is marked ${row.status === "deprecated" ? "deprecated" : "sunsetting"}` +
          `${row.sunset_on ? ` (sunset ${row.sunset_on})` : ""} — plan its removal`,
      );
    }
  }
  // Only prod can say a model is gone — staging routinely lags it or diverges.
  if (authoritative) {
    for (const id of MODEL_IDS) {
      if (!servedIds.has(id)) {
        report(`${label}: "${id}" is in MODELS but no longer served — retire it from src/defaults.js`);
      }
    }
  }
  // A served model nobody states limits for silently gets the conservative
  // DEFAULT_LIMIT floor. Distinct from "missing from MODELS": once the backend
  // publishes limits, a missing bootstrap entry no longer hurts users.
  for (const row of served) {
    const stated = MODEL_IDS.includes(row.id) || (row.limit?.context && row.limit?.output);
    if (!stated) {
      report(`${label}: "${row.id}" resolves to DEFAULT_LIMIT — nobody states its real context/output window`);
    }
  }
}

if (findings.length) {
  console.log(`\n${findings.length} drift finding(s). Reconcile MODELS in src/defaults.js with the backend.`);
  process.exit(1);
}
console.log("\nNo drift: the bootstrap catalog matches the backend.");
