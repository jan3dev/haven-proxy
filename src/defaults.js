// Shared defaults, kept in a leaf module that imports nothing so config.js and
// server.js can both use them without an import cycle. Both re-export the names
// they used to own, so no import site outside src/ has to change.

export const DEFAULT_BASE_URL = "https://ankara.aquabtc.com";
export const DEFAULT_PORT = 3301;

// All Haven models share one price today, in USD per 1M tokens. Inline a
// literal on a MODELS entry if pricing ever diverges.
export const DEFAULT_COST = { input: 1.8, output: 6.3 };

// One catalog: ids for the proxy's /v1/models, plus the display names, limits
// and cost OpenCode shows in its model picker. The limits are best-effort defaults.
export const MODELS = [
  { id: "gpt-oss-120b", name: "GPT-OSS 120B (Haven)", limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST },
  { id: "kimi-k2-6",    name: "Kimi K2.6 (Haven)",    limit: { context: 200000, output: 65536 }, cost: DEFAULT_COST },
  { id: "glm-5-2",      name: "GLM-5.2 (Haven)",      limit: { context: 200000, output: 65536 }, cost: DEFAULT_COST },
  { id: "gemma4-31b",   name: "Gemma 4 31B (Haven)",  limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST },
  { id: "llama3-3-70b", name: "Llama 3.3 70B (Haven)", limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST },
  { id: "qwen3-vl-30b", name: "Qwen3-VL 30B (Haven)", limit: { context: 131072, output: 32768 }, cost: DEFAULT_COST },
];

export const MODEL_IDS = MODELS.map((m) => m.id);

// Shape OpenCode expects under provider.<id>.models.
export const opencodeModels = () =>
  Object.fromEntries(MODELS.map(({ id, name, limit, cost }) => [id, { name, limit, cost }]));
