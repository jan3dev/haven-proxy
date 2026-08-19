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
// src/catalog.js); this is the fallback for a first run with no network, and the
// source of the display names and limits that endpoint doesn't carry. An entry
// here is not proof a model still exists — models get retired upstream.
export const MODELS = [
  { id: "gpt-oss-120b", name: "GPT-OSS 120B (Haven)", limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST },
  { id: "gpt-oss-safeguard-120b", name: "GPT-OSS Safeguard 120B (Haven)", limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST },
  { id: "kimi-k3",      name: "Kimi K3 (Haven)",      limit: { context: 200000, output: 65536 }, cost: DEFAULT_COST },
  { id: "glm-5-2",      name: "GLM-5.2 (Haven)",      limit: { context: 200000, output: 65536 }, cost: DEFAULT_COST },
  { id: "gemma4-31b",   name: "Gemma 4 31B (Haven)",  limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST },
  { id: "llama3-3-70b", name: "Llama 3.3 70B (Haven)", limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST },
];

export const MODEL_IDS = MODELS.map((m) => m.id);

const BUILTIN_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

// Turn the backend's `{ id, name, cost }` rows into full catalog entries. The
// backend owns which models exist and what they cost; names and limits come from
// MODELS, which is why a model we've never heard of still registers cleanly.
export const mergeCatalog = (fetched) =>
  fetched.map(({ id, name, cost }) => {
    const builtin = BUILTIN_BY_ID.get(id);
    return {
      id,
      name: builtin?.name ?? `${name || id} (Haven)`,
      limit: builtin?.limit ?? DEFAULT_LIMIT,
      cost,
    };
  });

// Shape OpenCode expects under provider.<id>.models.
export const opencodeModels = (models = MODELS) =>
  Object.fromEntries(models.map(({ id, name, limit, cost }) => [id, { name, limit, cost }]));
