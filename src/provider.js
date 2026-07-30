// In-process Haven provider for the Vercel AI SDK (and thus OpenCode) — no proxy
// daemon required. OpenCode dynamically imports this package, calls the first
// `create*` export with `{ name, ...options }`, and expects an AI SDK provider.
//
// We return an @ai-sdk/openai-compatible provider whose HTTP layer is a custom
// `fetch` that runs the Haven relay (attest + HPKE-encrypt + decrypt) in-process.
// Because we own that fetch, we inject `X-Api-Key` ourselves — sidestepping
// OpenCode's habit of dropping custom headers on custom baseURLs, which is the
// whole reason the standalone proxy existed.
//
// opencode.json (`haven-proxy login` writes this for you; options are optional —
// without them the key comes from HAVEN_API_KEY or ~/.haven-proxy/config.json):
//   {
//     "provider": {
//       "haven": {
//         "npm": "github:jan3dev/haven-proxy",
//         "options": {
//           "baseURL": "https://your-ankara-host/api/v1/haven",
//           "apiKey": "{env:HAVEN_API_KEY}"
//         },
//         "models": { "gpt-oss-120b": { "name": "GPT-OSS 120B (Haven)" } }
//       }
//     }
//   }
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createSecureRelay, sseLinesFor } from "./relay.js";
import { loadConfig } from "./config.js";

function decodeBody(body) {
  if (body == null) return {};
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function errorResponse(error) {
  const { status, message, type, code, retryAfter } = error;
  const headers = { "Content-Type": "application/json" };
  if (retryAfter) headers["Retry-After"] = retryAfter;
  return new Response(JSON.stringify({ error: { message, type, code, param: null } }), {
    status,
    headers,
  });
}

/**
 * Create a Haven provider for the Vercel AI SDK / OpenCode.
 *
 * @param {object} options
 * @param {string} [options.baseURL] - Haven origin incl. the API path, e.g.
 *   `https://your-ankara-host/api/v1/haven` (the client posts to `<baseURL>/chat/completions`).
 *   Falls back to HAVEN_BASE_URL / the saved config origin + `/api/v1/haven`.
 * @param {string} [options.apiKey] - Your `hvn1_…` Haven key (sent as `X-Api-Key`).
 *   Falls back to HAVEN_API_KEY, then the key saved by `haven-proxy login`.
 * @param {string} [options.name] - Provider id (OpenCode passes its provider id here).
 * @param {number} [options.timeoutMs] - Upstream deadline per request (default 300 000 ms).
 */
export function createHaven(options = {}) {
  const { name = "haven", timeoutMs } = options;

  // OpenCode substitutes "{env:HAVEN_API_KEY}" with "" when the variable is
  // unset; an unresolved "{env:…}"/"{file:…}" literal means substitution never
  // ran. Treat both as absent and fall back to the CLI's credential store,
  // matching its resolution order: options → env var → ~/.haven-proxy/config.json.
  const isUnresolvedTemplate = (v) => typeof v === "string" && /^\{(env|file):[^}]*\}$/.test(v);
  let apiKey = isUnresolvedTemplate(options.apiKey) ? "" : options.apiKey || "";
  let baseURL = isUnresolvedTemplate(options.baseURL) ? "" : options.baseURL || "";

  if (!apiKey || !baseURL) {
    // loadConfig applies HAVEN_API_KEY / HAVEN_BASE_URL env overrides itself.
    // cfg.baseURL is the bare origin; the provider needs the full API path.
    const { cfg } = loadConfig();
    if (!apiKey) apiKey = cfg.apiKey;
    if (!baseURL) baseURL = `${cfg.baseURL.replace(/\/+$/, "")}/api/v1/haven`;
  }

  if (!apiKey) {
    const msg =
      "Haven API key is missing. Run `haven-proxy login` (or `npx github:jan3dev/haven-proxy login`), " +
      "or set HAVEN_API_KEY in your environment, then restart OpenCode.";
    console.error(`[haven-proxy] ${msg}`);
    throw new Error(msg);
  }

  const havenApiRoot = baseURL.replace(/\/+$/, "");
  const relay = createSecureRelay({ havenApiRoot, apiKey, timeoutMs });

  // Custom fetch: the AI SDK calls this with a full URL and a JSON body string.
  // We only handle the chat/completions hop; anything else falls back untouched.
  const havenFetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    const method = (init.method || (typeof input === "object" ? input.method : "GET") || "GET").toUpperCase();
    if (method !== "POST" || !url.includes("/chat/completions")) {
      return globalThis.fetch(input, init);
    }

    const body = decodeBody(init.body);
    // Forward the AI SDK's abort signal so cancelling a generation in OpenCode
    // actually cancels the upstream request.
    const result = await relay.relay(body, { signal: init.signal ?? undefined });
    if (result.aborted) throw new DOMException("The request was aborted.", "AbortError");
    if (!result.ok) return errorResponse(result.error);

    const headers = new Headers({ "Content-Type": "application/json" });

    if (result.wantStream) {
      headers.set("Content-Type", "text/event-stream");
      const encoder = new TextEncoder();
      const lines = sseLinesFor(result.completion, result.includeUsage);
      const stream = new ReadableStream({
        start(controller) {
          for (const line of lines) controller.enqueue(encoder.encode(line));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers });
    }

    return new Response(JSON.stringify(result.completion), { status: 200, headers });
  };

  // No apiKey/headers passed here — auth is handled inside havenFetch (X-Api-Key),
  // so the AI SDK never adds an Authorization: Bearer header Haven would reject.
  return createOpenAICompatible({ name, baseURL: havenApiRoot, fetch: havenFetch });
}
