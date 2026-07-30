// Reusable OpenAI-compatible HTTP proxy server over the Haven relay core.
//
// Extracted from the CLI's `serve` branch so both front-ends share one server:
//   - src/index.js (CLI serve / start)
//   - app/ (Electron tray app, runs this in-process)
//
// The caller owns credential resolution and process lifecycle; this module owns
// routing, relay wiring, and the loopback safety guard.
import http from "node:http";
import { createSecureRelay, sseLinesFor, USAGE_HEADER, DEFAULT_TIMEOUT_MS } from "./relay.js";
import { DEFAULT_BASE_URL, DEFAULT_PORT, MODEL_IDS } from "./defaults.js";

export const MAX_BODY_BYTES = 256 * 1024; // mirror Haven's CHAT_COMPLETIONS_MAX_PAYLOAD_BYTES
export { DEFAULT_PORT };
export const DEFAULT_MODELS = MODEL_IDS;

export function isLoopbackHost(host) {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1" || h.startsWith("127.");
}

const consoleLog = { info: console.log, warn: console.warn, error: console.error };

// Build (but don't start) the proxy server. Returns:
//   server        — the http.Server (exposed for tests)
//   havenApiRoot  — resolved upstream API root
//   listen(opts)  — Promise; rejects with err.code EADDRINUSE (port taken) or
//                   ENONLOOPBACK (open-relay guard) so callers decide how to react
//   close()       — Promise; stops accepting connections
//   validate()    — key/balance check via the relay (tray-app status line)
export function createProxyServer({
  apiKey,
  baseURL = DEFAULT_BASE_URL,
  models = DEFAULT_MODELS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = consoleLog, // { info, warn, error }
} = {}) {
  if (!apiKey) throw new Error("createProxyServer: apiKey is required");
  const havenApiRoot = `${baseURL.replace(/\/+$/, "")}/api/v1/haven`;
  const relay = createSecureRelay({ havenApiRoot, apiKey, timeoutMs });

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
      data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "haven" })),
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

  async function warmup(host, port) {
    log.info(`[haven-proxy] listening on http://${host}:${port}/v1`);
    log.info(`[haven-proxy] relaying to ${havenApiRoot}/`);
    log.info(`[haven-proxy] models: ${models.join(", ")}`);
    try {
      await relay.ready(); // pre-warm attestation; not fatal if it fails now
      log.info("[haven-proxy] enclave attested ✓");
    } catch (err) {
      log.warn(
        `[haven-proxy] attestation not ready yet (will retry on first request): ${err?.message || err}`,
      );
    }
    const kv = await relay.validate();
    if (kv.ok) {
      log.info(`[haven-proxy] Haven key valid — balance: $${kv.balance.toFixed(2)} ✓`);
    } else if (kv.reason === "invalid_key") {
      log.error(
        "[haven-proxy] Haven key is INVALID — check your --api-key / HAVEN_API_KEY (requests will fail with 401).",
      );
    } else if (kv.reason === "empty_balance") {
      log.warn(
        `[haven-proxy] Haven key valid but balance is $0.00 — top up before sending requests.`,
      );
    } else {
      log.warn(
        "[haven-proxy] Could not reach Haven account endpoint to verify key (will retry on first request).",
      );
    }
  }

  return {
    server,
    havenApiRoot,
    listen({ port = DEFAULT_PORT, host = "127.0.0.1", allowRemote = false } = {}) {
      // This endpoint is UNAUTHENTICATED — it accepts any (dummy) client key and
      // relays with the funded Haven key. Bound to loopback that's fine; bound to
      // any other interface it's an open relay anyone reachable can spend the
      // balance through. The guard is a security invariant, so it lives here
      // rather than in any one caller.
      if (!isLoopbackHost(host) && !allowRemote) {
        const err = new Error(
          `Refusing to bind to non-loopback host "${host}": this endpoint is ` +
            `unauthenticated and relays with your funded Haven key, so anyone who can reach it ` +
            `can spend your balance. Pass --allow-remote to override intentionally.`,
        );
        err.code = "ENONLOOPBACK";
        return Promise.reject(err);
      }
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          warmup(host, port); // fire-and-forget: server is usable before attestation completes
          resolve({ host, port });
        });
      });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
    validate: () => relay.validate(),
  };
}
