// Tests the proxy's catalog top-up policy (src/server.js) — `npm test`.
//
// Nothing here relays: /v1/models never touches the enclave, so stubbing
// globalThis.fetch for the pricing probe is enough. The server is started via
// server.listen directly rather than the returned listen(), which skips warmup
// (and its attestation attempt) and leaves the refresh gate at its initial state.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "../src/server.js";
import { CATALOG_RETRY_MS, CATALOG_TTL_MS } from "../src/catalog.js";

const BASE = "https://ankara.example.com";
const SERVED = ["only-model-a", "only-model-b"];
const silent = { info() {}, warn() {}, error() {} };

let dir;
let savedEnv;
const realFetch = globalThis.fetch;

beforeEach(() => {
  savedEnv = process.env.HAVEN_CATALOG;
  dir = mkdtempSync(join(tmpdir(), "haven-srvcat-"));
  process.env.HAVEN_CATALOG = join(dir, "catalog.json");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedEnv === undefined) delete process.env.HAVEN_CATALOG;
  else process.env.HAVEN_CATALOG = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

// Pricing probe that fails until `online` flips, and counts every attempt.
function stubPricing(state) {
  globalThis.fetch = async (input) => {
    if (!String(input).includes("/pricing/")) throw new TypeError("fetch failed");
    state.calls++;
    if (!state.online) throw new TypeError("fetch failed");
    return new Response(
      JSON.stringify(SERVED.map((id) => ({ id, name: id, input_cost: "1.0", output_cost: "2.0" }))),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listModels(port) {
  const res = await realFetch(`http://127.0.0.1:${port}/v1/models`);
  const { data } = await res.json();
  return data.map((m) => m.id);
}

// The top-up is fire-and-forget, so a request reports the list it already had.
// Poll a bounded number of times for the next one to land.
async function pollUntilServed(port, want) {
  for (let i = 0; i < 60; i++) {
    const ids = await listModels(port);
    if (ids.join() === want.join()) return ids;
    await sleep(10);
  }
  return listModels(port);
}

describe("proxy catalog top-up", () => {
  test("a failed fetch is retried within minutes, not held for the full TTL", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const state = { online: false, calls: 0 };
    stubPricing(state);

    const srv = createProxyServer({ apiKey: "hvn1_test", baseURL: BASE, log: silent });
    await new Promise((r) => srv.server.listen(0, "127.0.0.1", r));
    const { port } = srv.server.address();
    t.after(() => srv.close());

    // First request finds no catalog anywhere, so it serves the built-in list.
    await listModels(port);
    await pollUntilServed(port, SERVED); // drains the failing attempt
    const afterOffline = state.calls;
    assert.ok(afterOffline >= 1, "the offline attempt should have been made");
    assert.notDeepEqual(await listModels(port), SERVED);

    // Still inside the retry window: no second attempt.
    t.mock.timers.tick(CATALOG_RETRY_MS - 1000);
    await listModels(port);
    await sleep(30);
    assert.equal(state.calls, afterOffline, "must not refetch inside the retry window");

    // Past it, the backend is back — the list must recover without a restart.
    state.online = true;
    t.mock.timers.tick(2000);
    assert.deepEqual(await pollUntilServed(port, SERVED), SERVED);
    assert.ok(state.calls > afterOffline, "a retry should have happened");

    // A list that did come from the backend holds for the full TTL.
    const afterOnline = state.calls;
    t.mock.timers.tick(CATALOG_TTL_MS - 1000);
    await listModels(port);
    await sleep(30);
    assert.equal(state.calls, afterOnline, "a backend list must not refetch inside the TTL");
  });
});
