#!/usr/bin/env node
// Local OpenAI-compatible HTTP proxy in front of the Haven (EHBP) relay.
//
// OpenCode (and any OpenAI-style client) speaks plaintext to this proxy on
// localhost; the proxy runs the SecureClient SDK to attest the enclave and
// HPKE-encrypt the body on THIS machine (see src/relay.js), relays the ciphertext
// through Haven, decrypts the reply, and re-serves it as OpenAI JSON/SSE. The
// end-to-end encryption never leaves your machine.
//
// For agents that can load a custom provider in-process (e.g. OpenCode), see
// src/provider.js — it uses the same relay core without any localhost daemon.
import http from "node:http";
import { parseArgs } from "node:util";

// Load .env from cwd so `haven-proxy` picks up the same variables as `npm start`
// (which passes --env-file=.env explicitly). On Windows there is no shell-level
// equivalent, so without this the binary silently starts with no key.
try { process.loadEnvFile(); } catch (e) { if (e?.code !== "ENOENT") throw e; }
import { createSecureRelay, sseLinesFor, USAGE_HEADER, DEFAULT_TIMEOUT_MS, validateKey } from "./relay.js";
import { loadConfig, saveConfig, deleteConfig, requireAuth, redactKey, promptApiKey, DEFAULT_BASE_URL, opencodeConfigPath, saveOpencodeProvider, removeOpencodeProvider } from "./config.js";

const MAX_BODY_BYTES = 256 * 1024; // mirror Haven's CHAT_COMPLETIONS_MAX_PAYLOAD_BYTES
const DEFAULT_MODELS = "gpt-oss-120b,kimi-k2-6,glm-5-2,gemma4-31b,llama3-3-70b,qwen3-vl-30b";

const HELP = `
haven-proxy — OpenAI-compatible localhost proxy for the Haven encrypted inference relay

Usage:
  haven-proxy [command] [options]
  npm start                       (loads .env automatically, then starts proxy)

Commands:
  login                           Save Haven API key to ~/.haven-proxy/config.json
  logout                          Remove saved credentials
  validate                        Check API key validity and account balance
  help                            Show this help

  (no command)                    Start the proxy (default)

Options (proxy start):
  -k, --api-key      <key>        Haven API key (hvn1_…)       [env: HAVEN_API_KEY]
  -u, --base-url     <url>        Ankara backend origin         [env: HAVEN_BASE_URL]   (default: ${DEFAULT_BASE_URL})
  -p, --port         <n>          Port to listen on             [env: PORT]             (default: 3301)
  -H, --host         <host>       Host to bind to               [env: HOST]             (default: 127.0.0.1)
  -m, --models       <list>       Comma-separated model ids     [env: HAVEN_MODELS]
  -t, --timeout      <ms>         Per-request deadline in ms    [env: HAVEN_TIMEOUT_MS] (default: ${DEFAULT_TIMEOUT_MS})
      --allow-remote              Allow non-loopback binding    [env: HAVEN_ALLOW_REMOTE=1]

Options (login):
  -k, --api-key      <key>        API key to save (prompts if omitted)

Global:
  -h, --help                      Show this help and exit

Credential resolution order: --api-key flag > HAVEN_API_KEY env var > ~/.haven-proxy/config.json
`.trim();

// Subcommand is the first non-flag argument (if any).
const subcommand = !process.argv[2] || process.argv[2].startsWith("-") ? null : process.argv[2];
const subArgs = subcommand ? process.argv.slice(3) : process.argv.slice(2);

// --- login ---
if (subcommand === "login") {
  const { values } = parseArgs({
    args: subArgs,
    options: {
      "api-key":  { type: "string", short: "k" },
      "base-url": { type: "string", short: "u" },
      "help":     { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) { console.log(HELP); }
  else {
    let apiKey = values["api-key"] || process.env.HAVEN_API_KEY || "";
    if (!apiKey) apiKey = await promptApiKey();
    if (!apiKey) {
      console.error("[haven-proxy] API key is required.");
      process.exitCode = 1;
    } else {
      const { cfg } = loadConfig();
      const baseURL = (values["base-url"] || cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
      const havenApiRoot = `${baseURL}/api/v1/haven`;
      process.stdout.write("[haven-proxy] Verifying key… ");
      const result = await validateKey(havenApiRoot, apiKey);
      if (result.reason === "invalid_key") {
        console.error("\n[haven-proxy] Key is invalid — check it and try again.");
        process.exitCode = 1;
      } else {
        if (result.reason === "unreachable") {
          console.warn("\n[haven-proxy] Could not reach Haven to verify the key — saving anyway.");
        } else if (result.ok) {
          process.stdout.write(`balance $${result.balance.toFixed(2)} ✓\n`);
        } else if (result.reason === "empty_balance") {
          process.stdout.write("valid (balance $0.00 — top up before sending requests)\n");
        }
        const path = saveConfig({ ...cfg, apiKey, baseURL });
        console.log(`[haven-proxy] Credentials saved to ${path}`);
        const ocTarget = opencodeConfigPath();
        console.log(`[haven-proxy] Writing Haven provider to ${ocTarget}…`);
        try {
          const { path: ocPath, existed, otherProviders } = saveOpencodeProvider(apiKey, baseURL);
          const preserved = otherProviders.length
            ? `(preserved: ${otherProviders.join(", ")})`
            : existed ? "(no other providers)" : "(new file)";
          console.log(`[haven-proxy] Haven provider written to ${ocPath} ${preserved}`);
          console.log(`[haven-proxy] Pick "haven/gpt-oss-120b" (or any Haven model) in OpenCode.`);
        } catch (err) {
          console.warn(`[haven-proxy] Warning: could not write to ${ocTarget}: ${err.message}`);
          console.warn(`[haven-proxy] Add the Haven provider to ${ocTarget} manually — see README.`);
        }
      }
    }
  }
  // Let the event loop drain before exit (avoids libuv handle assertion on Windows)
  process.exitCode = process.exitCode ?? 0;
}

// --- logout ---
else if (subcommand === "logout") {
  const { path, removed } = deleteConfig();
  if (removed) {
    console.log(`[haven-proxy] Removed ${path}`);
  } else {
    console.log(`[haven-proxy] No credentials to remove (${path} did not exist)`);
  }
  const { path: ocPath, removed: ocRemoved } = removeOpencodeProvider();
  if (ocRemoved) console.log(`[haven-proxy] Removed Haven provider from ${ocPath}`);
  process.exitCode = 0;
}

// --- validate ---
else if (subcommand === "validate") {
  const { values } = parseArgs({
    args: subArgs,
    options: {
      "api-key": { type: "string", short: "k" },
      "help":    { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) { console.log(HELP); }
  else {
    const cfg = requireAuth(values["api-key"]);
    const havenApiRoot = `${cfg.baseURL.replace(/\/+$/, "")}/api/v1/haven`;
    console.log(`[haven-proxy] API key:  ${redactKey(cfg.apiKey)}`);
    console.log(`[haven-proxy] Backend:  ${cfg.baseURL}`);
    const result = await validateKey(havenApiRoot, cfg.apiKey);
    let exitCode = 0;
    if (result.ok) {
      console.log(`[haven-proxy] Balance:  $${result.balance.toFixed(2)} ✓`);
    } else if (result.reason === "invalid_key") {
      console.error("[haven-proxy] Balance:  key is INVALID (401)");
      exitCode = 1;
    } else if (result.reason === "empty_balance") {
      console.warn(`[haven-proxy] Balance:  $0.00 — top up before sending requests`);
    } else {
      console.warn("[haven-proxy] Balance:  could not reach Haven account endpoint");
    }
    process.exitCode = exitCode;
  }
}

// --- help ---
else if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
  console.log(HELP);
  process.exitCode = 0;
}

else {

// --- start proxy (default) ---
const { values: flags } = parseArgs({
  args: subArgs,
  options: {
    "api-key":     { type: "string",  short: "k" },
    "base-url":    { type: "string",  short: "u" },
    "port":        { type: "string",  short: "p" },
    "host":        { type: "string",  short: "H" },
    "models":      { type: "string",  short: "m" },
    "timeout":     { type: "string",  short: "t" },
    "allow-remote":{ type: "boolean" },
    "help":        { type: "boolean", short: "h" },
  },
  strict: true,
});

if (flags.help) { console.log(HELP); process.exitCode = 0; }

// Resolution order: flag > env var > config file > hardcoded default
const cfg = requireAuth(flags["api-key"]);
const HAVEN_API_KEY = flags["api-key"] || cfg.apiKey;
const HAVEN_BASE_URL = (flags["base-url"] || cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
const HOST = flags["host"] || process.env.HOST || "127.0.0.1";
const PORT = Number(flags["port"] || process.env.PORT || 3301);

// This endpoint is UNAUTHENTICATED — it accepts any (dummy) client key and relays
// with the funded HAVEN_API_KEY. Bound to loopback that's fine; bound to any other
// interface it's an open relay anyone reachable can spend your balance through.
// Refuse to start off-loopback unless the operator explicitly opts in.
function isLoopbackHost(host) {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1" || h.startsWith("127.");
}
const allowRemote = flags["allow-remote"] || process.env.HAVEN_ALLOW_REMOTE === "1";
if (!isLoopbackHost(HOST) && !allowRemote) {
  console.error(
    `[haven-proxy] Refusing to bind to non-loopback host "${HOST}": this endpoint is ` +
      `unauthenticated and relays with your funded Haven key, so anyone who can reach it ` +
      `can spend your balance. Pass --allow-remote to override intentionally.`,
  );
  process.exit(1);
}

const MODELS = (flags["models"] || process.env.HAVEN_MODELS || DEFAULT_MODELS)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// Per-request upstream deadline (ms). Responses are buffered (no true streaming),
// so long generations legitimately take minutes — keep this generous.
const timeoutRaw = flags["timeout"] || process.env.HAVEN_TIMEOUT_MS;
const TIMEOUT_MS = Number(timeoutRaw || DEFAULT_TIMEOUT_MS);
if (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
  console.error(
    `[haven-proxy] --timeout / HAVEN_TIMEOUT_MS must be a positive number of milliseconds, got "${timeoutRaw}".`,
  );
  process.exit(1);
}

const HAVEN_API_ROOT = `${HAVEN_BASE_URL}/api/v1/haven`;
const relay = createSecureRelay({
  havenApiRoot: HAVEN_API_ROOT,
  apiKey: HAVEN_API_KEY,
  timeoutMs: TIMEOUT_MS,
});

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// OpenAI-shaped error envelope so the AI SDK surfaces something readable.
function sendError(res, status, message, { type = "api_error", code = null, retryAfter } = {}) {
  if (retryAfter) res.setHeader("Retry-After", retryAfter);
  sendJson(res, status, { error: { message, type, code, param: null } });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error("payload too large");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleChatCompletions(req, res) {
  // Cancel the upstream relay if the client goes away (OpenCode aborting a
  // generation, dropped connection). Without this the request would keep
  // running and spending balance on output nobody reads. `close` also fires
  // after a normal response — `writableEnded` distinguishes the two.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendError(res, 400, "Request body is not valid JSON.", {
      type: "invalid_request_error",
    });
  }

  const result = await relay.relay(body, { signal: controller.signal });
  if (controller.signal.aborted) return; // client is gone — nothing to write to
  if (!result.ok) {
    const { status, message, type, code, retryAfter } = result.error;
    return sendError(res, status, message, { type, code, retryAfter });
  }

  if (result.usage) res.setHeader(USAGE_HEADER, result.usage);

  if (result.wantStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const line of sseLinesFor(result.completion, result.includeUsage)) res.write(line);
    return res.end();
  }
  return sendJson(res, 200, result.completion);
}

function handleModels(res) {
  sendJson(res, 200, {
    object: "list",
    data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "haven" })),
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && (pathname === "/health" || pathname === "/")) {
    return sendJson(res, 200, { status: "ok" });
  }
  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    return handleModels(res);
  }
  if (
    req.method === "POST" &&
    (pathname === "/v1/chat/completions" || pathname === "/chat/completions")
  ) {
    return handleChatCompletions(req, res).catch((err) => {
      // Client disconnects mid-body reject readBody — nothing left to answer.
      if (res.destroyed) return;
      const status = err?.statusCode || 500;
      if (!res.headersSent) sendError(res, status, err?.message || "Internal proxy error.");
      else res.end();
    });
  }
  return sendError(res, 404, `No route for ${req.method} ${pathname}.`, {
    type: "invalid_request_error",
  });
});

server.listen(PORT, HOST, async () => {
  console.log(`[haven-proxy] listening on http://${HOST}:${PORT}/v1`);
  console.log(`[haven-proxy] relaying to ${HAVEN_API_ROOT}/`);
  console.log(`[haven-proxy] models: ${MODELS.join(", ")}`);
  try {
    await relay.ready(); // pre-warm attestation; not fatal if it fails now
    console.log("[haven-proxy] enclave attested ✓");
  } catch (err) {
    console.warn(
      `[haven-proxy] attestation not ready yet (will retry on first request): ${err?.message || err}`,
    );
  }
  const kv = await relay.validate();
  if (kv.ok) {
    console.log(`[haven-proxy] Haven key valid — balance: $${kv.balance.toFixed(2)} ✓`);
  } else if (kv.reason === "invalid_key") {
    console.error(
      "[haven-proxy] Haven key is INVALID — check your --api-key / HAVEN_API_KEY (requests will fail with 401).",
    );
  } else if (kv.reason === "empty_balance") {
    console.warn(
      `[haven-proxy] Haven key valid but balance is $0.00 — top up before sending requests.`,
    );
  } else {
    console.warn(
      "[haven-proxy] Could not reach Haven account endpoint to verify key (will retry on first request).",
    );
  }
});

} // end else (start proxy)
