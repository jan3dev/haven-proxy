// Shared defaults, kept in a leaf module that imports nothing so config.js and
// server.js can both use them without an import cycle. Both re-export the names
// they used to own, so no import site outside src/ has to change.

export const DEFAULT_BASE_URL = "https://ankara.aquabtc.com";
export const DEFAULT_PORT = 3301;

// All Haven models share one price today, in USD per 1M tokens. Inline a
// literal on a MODELS entry if pricing ever diverges.
export const DEFAULT_COST = { input: 1.8, output: 6.3 };

// Context/output ceiling for a model the backend serves but this list doesn't
// describe — a conservative floor, since guessing high truncates real requests.
export const DEFAULT_LIMIT = { context: 131072, output: 32768 };

// Bootstrap catalog: what we assume the backend serves until it tells us
// otherwise. The live list comes from the backend's pricing endpoint (see
// src/catalog.js); this is only the fallback for a first run with no network,
// and it fills any field the endpoint doesn't publish yet. An entry here is not
// proof a model still exists — models get retired upstream. Capability fields
// are optional and only stated where known; the backend's values outrank them.
export const MODELS = [
  { id: "gpt-oss-120b", name: "GPT-OSS 120B (Haven)", limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST, capabilities: { tool_call: true, reasoning: true } },
  { id: "gpt-oss-safeguard-120b", name: "GPT-OSS Safeguard 120B (Haven)", limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST, capabilities: { tool_call: true, reasoning: true } },
  { id: "kimi-k3",      name: "Kimi K3 (Haven)",      limit: { context: 200000, output: 65536 }, cost: DEFAULT_COST, capabilities: { tool_call: true } },
  { id: "glm-5-2",      name: "GLM-5.2 (Haven)",      limit: { context: 200000, output: 65536 }, cost: DEFAULT_COST, capabilities: { tool_call: true } },
  { id: "gemma4-31b",   name: "Gemma 4 31B (Haven)",  limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST },
  { id: "llama3-3-70b", name: "Llama 3.3 70B (Haven)", limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST, capabilities: { tool_call: true } },
];

export const MODEL_IDS = MODELS.map((m) => m.id);

// Preferred default model for fresh OpenCode setups: cheapest and fast. If the
// live catalog no longer serves it, fall back to whatever the backend lists first.
export const DEFAULT_MODEL_ID = "gpt-oss-120b";
export const defaultModelId = (models = MODELS) =>
  models.some((m) => m.id === DEFAULT_MODEL_ID) ? DEFAULT_MODEL_ID : models[0]?.id;

const BUILTIN_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

// Turn the backend's catalog rows (see fetchCatalog in relay.js) into full
// catalog entries. The backend is the one component that knows what it serves,
// so every field it publishes wins; MODELS only fills the gaps, which is why a
// model we've never heard of still registers cleanly. Resolution is per field,
// not per entry — a backend that publishes context_length but not max_output
// still gets the built-in output ceiling.
export const mergeCatalog = (fetched) =>
  fetched.map((row) => {
    const builtin = BUILTIN_BY_ID.get(row.id);
    const capabilities = { ...builtin?.capabilities, ...row.capabilities };
    const modalities = row.modalities ?? builtin?.modalities;
    const status = row.status ?? builtin?.status;
    // Undefined fields are omitted, not written as null — it keeps the generated
    // opencode.json minimal and the staleness comparison in config.js stable.
    return {
      id: row.id,
      name: row.name ? `${row.name} (Haven)` : (builtin?.name ?? `${row.id} (Haven)`),
      limit: {
        context: row.limit?.context ?? builtin?.limit?.context ?? DEFAULT_LIMIT.context,
        output: row.limit?.output ?? builtin?.limit?.output ?? DEFAULT_LIMIT.output,
      },
      cost: row.cost,
      ...(Object.keys(capabilities).length && { capabilities }),
      ...(modalities && { modalities }),
      ...(status && { status }),
      ...(row.sunset_on && { sunset_on: row.sunset_on }),
    };
  });

// Shape OpenCode expects under provider.<id>.models. Its schema takes the
// capability booleans flat on the model entry; sunset_on is proxy-only (it
// drives the retirement warning) and deliberately never written.
export const opencodeModels = (models = MODELS) =>
  Object.fromEntries(
    models.map(({ id, name, limit, cost, capabilities, modalities, status }) => [
      id,
      {
        name,
        limit,
        cost,
        ...capabilities,
        ...(modalities && { modalities }),
        ...(status && { status }),
      },
    ]),
  );
