// Tests for the model catalog (src/catalog.js) — `npm test`.
//
// Every case points HAVEN_CATALOG at a fresh temp file and stubs globalThis.fetch,
// so nothing here touches the developer's real ~/.haven-proxy or the network.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCatalog, CATALOG_TTL_MS, SUNSET_WARNING_MS } from "../src/catalog.js";
import { MODELS, MODEL_IDS, DEFAULT_LIMIT } from "../src/defaults.js";

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
      async () => jsonResponse([priced("newcomer-9b", "Newcomer 9B")]),
      () => resolveCatalog(ROOT, { now: NOW }),
    );

    assert.deepEqual(models, [
      { id: "newcomer-9b", name: "Newcomer 9B (Haven)", limit: DEFAULT_LIMIT, cost: { input: 1.5, output: 5.25 } },
    ]);
  });

  test("a known model keeps its built-in limit while /pricing/ doesn't publish one", async () => {
    const { models } = await withFetch(
      async () => jsonResponse([priced("gpt-oss-120b", "GPT-OSS 120B")]),
      () => resolveCatalog(ROOT, { now: NOW }),
    );

    assert.equal(models[0].name, "GPT-OSS 120B (Haven)");
    assert.deepEqual(models[0].limit, { context: 131072, output: 32768 });
  });

  test("backend-published name, limits and capabilities beat the built-in entry", async () => {
    const { models } = await withFetch(
      async () =>
        jsonResponse([
          {
            ...priced("gpt-oss-120b", "GPT-OSS 120B Turbo"), // renamed upstream
            context_length: 262144,
            max_output: 65536,
            capabilities: { reasoning: false, attachment: true },
          },
        ]),
      () => resolveCatalog(ROOT, { now: NOW }),
    );

    assert.equal(models[0].name, "GPT-OSS 120B Turbo (Haven)");
    assert.deepEqual(models[0].limit, { context: 262144, output: 65536 });
    // Backend keys override; built-in tool_call fills the gap it left.
    assert.deepEqual(models[0].capabilities, { tool_call: true, reasoning: false, attachment: true });
  });

  test("partial metadata falls back per field, not per entry", async () => {
    const { models } = await withFetch(
      async () => jsonResponse([{ ...priced("kimi-k3", "Kimi K3"), context_length: 262144 }]),
      () => resolveCatalog(ROOT, { now: NOW }),
    );

    // Backend context + built-in output (kimi-k3's built-in entry says 65536).
    assert.deepEqual(models[0].limit, { context: 262144, output: 65536 });
  });

  test("retiring lists deprecated and soon-sunsetting models, not far-future ones", async () => {
    const soon = new Date(NOW + SUNSET_WARNING_MS - 1000).toISOString().slice(0, 10);
    const far = new Date(NOW + SUNSET_WARNING_MS + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const result = await withFetch(
      async () =>
        jsonResponse([
          { ...priced("old-model", "Old"), status: "deprecated" },
          { ...priced("fading-model", "Fading"), sunset_on: soon },
          { ...priced("healthy-model", "Healthy"), status: "active", sunset_on: far },
        ]),
      () => resolveCatalog(ROOT, { now: NOW }),
    );

    assert.deepEqual(result.retiring, [
      { id: "old-model", status: "deprecated" },
      { id: "fading-model", sunset_on: soon },
    ]);
    // Warn, never block: a retiring model still counts as servable.
    assert.deepEqual(result.servableIds, ["old-model", "fading-model", "healthy-model"]);
  });

  test("retiring flows from the cache too, and the built-in fallback reports none", async () => {
    writeCache([{ ...priced("old-model", "Old"), status: "deprecated" }], NOW - 1000);
    const cached = await withFetch(offline, () => resolveCatalog(ROOT, { now: NOW }));
    assert.deepEqual(cached.retiring, [{ id: "old-model", status: "deprecated" }]);

    rmSync(process.env.HAVEN_CATALOG);
    const builtin = await withFetch(offline, () => resolveCatalog(ROOT, { now: NOW }));
    assert.equal(builtin.source, "builtin");
    assert.deepEqual(builtin.retiring, []);
  });

  // Backward-compatibility guarantee: with no metadata published (today's live
  // backend shape), the merged entry is exactly what the pre-metadata proxy
  // produced — no new keys, not even empty ones.
  test("a metadata-free row merges identically to before for an unannotated model", async () => {
    const builtin = MODELS.find((m) => !m.capabilities); // gemma4-31b today
    const bare = builtin.name.replace(" (Haven)", "");
    const { models } = await withFetch(
      async () => jsonResponse([priced(builtin.id, bare)]),
      () => resolveCatalog(ROOT, { now: NOW }),
    );

    assert.deepEqual(models, [
      { id: builtin.id, name: builtin.name, limit: builtin.limit, cost: { input: 1.5, output: 5.25 } },
    ]);
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
