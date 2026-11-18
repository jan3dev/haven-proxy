// Tests the proxy's request-size cap (src/server.js) — `npm test`.
//
// Nothing here relays: both bodies are rejected before the enclave is reached, the
// oversized one by the cap and the other as invalid JSON.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, MAX_BODY_BYTES } from "../src/server.js";

const silent = { info() {}, warn() {}, error() {} };

let dir;
let savedEnv;
const realFetch = globalThis.fetch;

beforeEach(() => {
  savedEnv = process.env.HAVEN_CATALOG;
  dir = mkdtempSync(join(tmpdir(), "haven-bodylimit-"));
  process.env.HAVEN_CATALOG = join(dir, "catalog.json");
  // The chat handler tops up the catalog in the background; keep it off the network.
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedEnv === undefined) delete process.env.HAVEN_CATALOG;
  else process.env.HAVEN_CATALOG = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

async function postChat(t, bytes) {
  const srv = createProxyServer({
    apiKey: "hvn1_test",
    baseURL: "https://ankara.example.com",
    log: silent,
  });
  await new Promise((r) => srv.server.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const { port } = srv.server.address();
  return realFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "x".repeat(bytes),
  });
}

describe("request size cap", () => {
  test("a body at the cap is read in full", async (t) => {
    const res = await postChat(t, MAX_BODY_BYTES);
    // 400 is the JSON parser's verdict, which only a fully read body can reach.
    assert.equal(res.status, 400);
  });

  test("a body over the cap is rejected with 413", async (t) => {
    const res = await postChat(t, MAX_BODY_BYTES + 1);
    assert.equal(res.status, 413);
    const { error } = await res.json();
    assert.equal(error.message, "payload too large");
  });
});
