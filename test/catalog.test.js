// Tests for the model catalog (src/catalog.js) — `npm test`.
//
// Every case points HAVEN_CATALOG at a fresh temp file and stubs globalThis.fetch,
// so nothing here touches the developer's real ~/.haven-proxy or the network.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCatalog, CATALOG_TTL_MS } from "../src/catalog.js";
import { MODEL_IDS, DEFAULT_LIMIT } from "../src/defaults.js";

const ROOT = "https://ankara.example.com/api/v1/haven";
const NOW = 1_700_000_000_000;

let dir;
let savedCatalogEnv;
const realFetch = globalThis.fetch;

const priced = (id, name) => ({ id, name, input_cost: "1.50", output_cost: "5.25" });
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const withFetch = async (impl, run) => {
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
};
const offline = async () => {
  throw new TypeError("fetch failed");
};

beforeEach(() => {
  savedCatalogEnv = process.env.HAVEN_CATALOG;
  dir = mkdtempSync(join(tmpdir(), "haven-cat-"));
  process.env.HAVEN_CATALOG = join(dir, "catalog.json");
});

afterEach(() => {
  if (savedCatalogEnv === undefined) delete process.env.HAVEN_CATALOG;
  else process.env.HAVEN_CATALOG = savedCatalogEnv;
  rmSync(dir, { recursive: true, force: true });
});

const readCache = () => JSON.parse(readFileSync(process.env.HAVEN_CATALOG, "utf8"));
const writeCache = (models, fetchedAt) =>
  writeFileSync(process.env.HAVEN_CATALOG, JSON.stringify({ fetchedAt, models }));

describe("resolveCatalog", () => {
  test("a live catalog wins, and is cached for next time", async () => {
    const result = await withFetch(
      async () => jsonResponse([priced("gpt-oss-120b", "GPT-OSS 120B"), priced("kimi-k3", "Kimi K3")]),
      () => resolveCatalog(ROOT, { now: NOW }),
    );

    assert.equal(result.source, "backend");
    assert.deepEqual(result.servableIds, ["gpt-oss-120b", "kimi-k3"]);
    assert.deepEqual(readCache().models.map((m) => m.id), ["gpt-oss-120b", "kimi-k3"]);
    assert.equal(readCache().fetchedAt, NOW);
  });

  test("a model we've never heard of registers with a usable name and limit", async () => {
    const { models } = await withFetch(
      async () => jsonResponse([priced("kimi-k3", "Kimi K3")]),
      () => resolveCatalog(ROOT, { now: NOW }),
    );

    assert.deepEqual(models, [
      { id: "kimi-k3", name: "Kimi K3 (Haven)", limit: DEFAULT_LIMIT, cost: { input: 1.5, output: 5.25 } },
    ]);
  });

  test("a known model keeps its built-in name and context limit", async () => {
    // /pricing/ carries neither, so they have to come from the built-in list.
    const { models } = await withFetch(
      async () => jsonResponse([priced("gpt-oss-120b", "GPT-OSS 120B")]),
      () => resolveCatalog(ROOT, { now: NOW }),
    );

    assert.equal(models[0].name, "GPT-OSS 120B (Haven)");
    assert.deepEqual(models[0].limit, { context: 131072, output: 32768 });
  });

  test("offline with a fresh cache: serve it, and still reject against it", async () => {
    writeCache([priced("gpt-oss-120b", "GPT-OSS 120B")], NOW - CATALOG_TTL_MS + 1000);

    const result = await withFetch(offline, () => resolveCatalog(ROOT, { now: NOW }));

    assert.equal(result.source, "cache");
    assert.deepEqual(result.servableIds, ["gpt-oss-120b"]);
  });

  test("offline with a stale cache: still serve it, but stop rejecting against it", async () => {
    // Blocking a model that does work is worse than the failure it would prevent.
    writeCache([priced("gpt-oss-120b", "GPT-OSS 120B")], NOW - CATALOG_TTL_MS - 1000);

    const result = await withFetch(offline, () => resolveCatalog(ROOT, { now: NOW }));

    assert.equal(result.source, "cache");
    assert.deepEqual(result.models.map((m) => m.id), ["gpt-oss-120b"]);
    assert.equal(result.servableIds, null);
  });

  test("offline with no cache falls back to the built-in list and never rejects", async () => {
    const result = await withFetch(offline, () => resolveCatalog(ROOT, { now: NOW }));

    assert.equal(result.source, "builtin");
    assert.deepEqual(result.models.map((m) => m.id), MODEL_IDS);
    assert.equal(result.servableIds, null, "an assumption must not be enforced as fact");
  });

  test("a corrupt cache is ignored rather than trusted", async () => {
    writeFileSync(process.env.HAVEN_CATALOG, "{not json");

    const result = await withFetch(offline, () => resolveCatalog(ROOT, { now: NOW }));

    assert.equal(result.source, "builtin");
  });

  test("an empty backend catalog is treated as unusable, not as 'nothing available'", async () => {
    const result = await withFetch(
      async () => jsonResponse([]),
      () => resolveCatalog(ROOT, { now: NOW }),
    );

    assert.equal(result.source, "builtin");
    assert.equal(result.servableIds, null);
    assert.equal(existsSync(process.env.HAVEN_CATALOG), false, "nothing usable to cache");
  });
});
