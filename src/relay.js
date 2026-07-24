// Shared Haven relay core — used by both the HTTP proxy (src/index.js) and the
// in-process OpenCode provider (src/provider.js).
//
// It runs the SecureClient SDK locally to attest the enclave and HPKE-encrypt the
// request body, relays the ciphertext through Haven (which injects the upstream
// API key and meters tokens without seeing the plaintext), decrypts the reply,
// and returns a plain result object. Callers turn that into an HTTP response (the
// proxy) or a Web `Response` for the AI SDK (the provider).
import { AsyncLocalStorage } from "node:async_hooks";
import { SecureClient } from "tinfoil";

export const USAGE_HEADER = "X-Tinfoil-Usage-Metrics";
export const INSUFFICIENT_BALANCE_MSG =
  "Haven balance is empty. Top up your Haven account to keep using inference.";

// Upstream deadline per relayed request. Without it, one hung enclave call would
// hang its caller (and any client waiting on it) forever.
export const DEFAULT_TIMEOUT_MS = 300_000;

// Best-effort probes (e.g. the balance check) get a short leash of their own so
// the error path can't hang either.
const PROBE_TIMEOUT_MS = 10_000;

// Force a buffered upstream response (stream:false): Haven meters via a cleartext
// usage header it can only read on a non-streamed reply, so we always ask Haven
// for the whole completion and re-synthesize the stream locally if the caller
// wanted one. Returns the flags needed to shape the response.
export function prepareUpstream(body) {
  const wantStream = body.stream === true;
  const includeUsage = wantStream && body.stream_options?.include_usage === true;
  const upstreamBody = { ...body, stream: false };
  delete upstreamBody.stream_options;
  return { wantStream, includeUsage, upstreamBody };
}

// Re-emit a fully-buffered completion as OpenAI SSE lines (each a complete
// `data: …\n\n` frame, terminated by `data: [DONE]`). Concatenation is lossless;
// splitting content on word boundaries just makes it visually stream.
export function sseLinesFor(completion, includeUsage) {
  const lines = [];
  const { id, created, model } = completion;
  const choice = completion.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const base = { id, object: "chat.completion.chunk", created, model };
  const push = (delta, finish_reason = null) =>
    lines.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);

  push({ role: "assistant" });
  if (message.reasoning_content) push({ reasoning_content: message.reasoning_content });
  if (message.content) {
    for (const piece of message.content.match(/\s*\S+|\s+/g) ?? []) push({ content: piece });
  }
  for (const [i, tc] of (message.tool_calls ?? []).entries()) {
    push({
      tool_calls: [
        {
          index: tc.index ?? i,
          id: tc.id,
          type: "function",
          function: { name: tc.function?.name, arguments: tc.function?.arguments ?? "" },
        },
      ],
    });
  }
  push({}, choice.finish_reason ?? "stop");
  if (includeUsage && completion.usage) {
    lines.push(`data: ${JSON.stringify({ ...base, choices: [], usage: completion.usage })}\n\n`);
  }
  lines.push("data: [DONE]\n\n");
  return lines;
}

// Process-wide fetch wrapper, consulted through AsyncLocalStorage.
//
// Why it exists — two SDK gaps, one hook point:
//  1. On a non-2xx, Haven's reply carries no EHBP nonce header, so the SDK
//     throws a generic protocol error from deep in its transport and discards
//     the real HTTP status and error body.
//  2. The EHBP transport rebuilds the Request without `init.signal` before the
//     real network hop, so a caller's abort/timeout signal never reaches the
//     socket.
// The SDK calls globalThis.fetch internally and exposes no response hook, so we
// wrap globalThis.fetch once (lazily, on first relay call) and scope each relay
// call's { signal, capture } to that call's async context. Because the store
// follows async causality, every in-flight relay call — concurrent calls on one
// instance (a well-funded key now runs these in parallel) as much as calls across
// instances — sees only its own store and can never abort or capture another
// call's request. Fetches from unrelated code see no store and pass through
// untouched. A swap-and-restore wrapper could guarantee none of this: nested
// wrappers see each other's traffic.
const fetchContext = new AsyncLocalStorage();
let realFetch = null;
function ensureFetchWrapper() {
  if (realFetch) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const ctx = fetchContext.getStore();
    if (!ctx) return realFetch(input, init);
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input?.url ?? "");
    // Attach the abort signal to the chat/completions hop ONLY — never to the
    // shared attestation/HPKE-keys fetches. Tinfoil dedupes attestation across
    // concurrent calls on one client (one `ready()` / `initPromise`); aborting
    // that shared fetch on one call's timeout tears down init for every other
    // in-flight call (and trips tinfoil's transient-error retry). A hang in
    // those shared fetches is instead covered by the onAbort backstop in relay().
    if (ctx.signal && ctx.isHavenUrl(url) && url.includes("/chat/completions")) {
      init = { ...init, signal: ctx.signal };
    }
    const response = await realFetch(input, init);
    try {
      // Looser than the abort check on purpose: capture is best-effort
      // bookkeeping, and the store already scopes it to this relay call.
      const sameBackend = !ctx.havenHost || url.includes(ctx.havenHost);
      if (sameBackend && url.includes("/chat/completions") && !response.ok) {
        let payload = {};
        try {
          payload = await response.clone().json();
        } catch {
          /* opaque/undecodable error body — status alone still helps */
        }
        ctx.captured = {
          status: response.status,
          payload,
          retryAfter: response.headers.get("retry-after"),
        };
      }
    } catch {
      /* capture is best-effort bookkeeping; never let it break a real request */
    }
    return response;
  };
}

// Map a Haven error envelope ({error_code, message, details}) at a given HTTP
// status onto an OpenAI-style error descriptor { status, message, type, code }.
export function classifyHavenError(status, payload = {}) {
  const detail = payload.message || payload.error_code;
  // Haven relays the enclave's EHBP problem+json verbatim (it's the SDK's
  // re-attest-and-retry signal, handled inside SecureClient.fetch). Seeing one
  // here means that recovery already ran and failed against a fresh key.
  if (typeof payload.type === "string" && payload.type.startsWith("urn:ietf:params:ehbp:error:")) {
    const problem = payload.title || payload.detail;
    return {
      status: 502,
      message:
        `Haven enclave rejected the encrypted request${problem ? ` (${problem})` : ""} even after ` +
        "re-attesting. Restart the client; if it persists, the enclave may be misbehaving.",
      type: "api_error",
      code: "enclave_key_mismatch",
    };
  }
  // Haven wraps any other enclave failure as HAVEN_UPSTREAM_ERROR and carries
  // the enclave's own status in details.status. A 429 there is a real upstream
  // rate limit, not a proxy fault — surface it as such so it's actionable.
  if (payload.error_code === "HAVEN_UPSTREAM_ERROR") {
    const upstreamStatus = payload.details?.status;
    if (upstreamStatus === 422) {
      // Pre-passthrough Haven deployments wrap the EHBP signal instead of
      // relaying it; reaching here means the relay's own reset-and-retry (see
      // relay()) already failed against a fresh attestation.
      return {
        status: 502,
        message:
          "Haven enclave rejected the encrypted request (HTTP 422) even after re-attesting. " +
          "Restart the client; if it persists, the enclave may be misbehaving.",
        type: "api_error",
        code: "enclave_key_mismatch",
      };
    }
    // Bad params / unknown model: the enclave's own message is the actionable
    // part (Haven forwards it, secret-free, as details.upstream_message). Keep
    // the enclave's 4xx status so clients don't retry a deterministic failure.
    if ((upstreamStatus === 400 || upstreamStatus === 404) && payload.details?.upstream_message) {
      return {
        status: upstreamStatus,
        message: payload.details.upstream_message,
        type: "invalid_request_error",
        code: "upstream_rejected",
      };
    }
    if (upstreamStatus === 429) {
      return {
        status: 429,
        message:
          "Haven inference is rate-limited upstream (429). Wait a moment and retry, or try another model.",
        type: "rate_limit_error",
        code: "upstream_rate_limited",
      };
    }
    return {
      status: 502,
      message: detail || `Haven inference upstream error (HTTP ${upstreamStatus ?? status}).`,
      type: "api_error",
      code: payload.error_code,
    };
  }
  switch (status) {
    case 400:
      // Haven returns 400 (not 402) when the account balance is empty.
      return {
        status: 402,
        message: INSUFFICIENT_BALANCE_MSG,
        type: "insufficient_quota",
        code: "insufficient_balance",
      };
    case 401:
      return {
        status: 401,
        message: "Invalid Haven API key — check your key.",
        type: "authentication_error",
        code: "invalid_api_key",
      };
    case 402:
      return {
        status: 402,
        message: INSUFFICIENT_BALANCE_MSG,
        type: "insufficient_quota",
        code: "insufficient_balance",
      };
    case 409:
      // Only near-empty keys hit this: Haven serves well-funded keys concurrently.
      // Prefer Haven's own message (it explains the balance condition), then fall
      // back to a hint to top up for concurrency.
      return {
        status: 409,
        message:
          detail ||
          "Another request for this near-empty Haven key is still in progress — add funds to run requests concurrently.",
        type: "server_error",
        code: "request_in_progress",
      };
    default:
      return {
        status: status >= 500 ? status : 502,
        message: detail || `Haven upstream error (HTTP ${status}).`,
        type: "api_error",
        code: payload.error_code || null,
      };
  }
}

// Probe the plaintext account endpoint and return a structured result so callers
// can distinguish "invalid key" from "empty balance" from "network unreachable".
// Returns one of:
//   { ok: true,  balance: number }           — key valid, balance in USD
//   { ok: false, reason: "invalid_key" }     — 401 from Haven
//   { ok: false, reason: "empty_balance" }   — key valid but balance ≤ 0
//   { ok: false, reason: "unreachable" }     — network error or unexpected status
export async function validateKey(havenApiRoot, apiKey) {
  try {
    const res = await globalThis.fetch(`${havenApiRoot}/account/`, {
      headers: { "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 401) return { ok: false, reason: "invalid_key" };
    if (!res.ok) return { ok: false, reason: "unreachable" };
    const data = await res.json();
    const balance = Number(data.usd_balance);
    if (balance <= 0) return { ok: false, reason: "empty_balance", balance };
    return { ok: true, balance };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

// Kept for the internal relay fallback path (balance probe on encrypted-relay failure).
async function fetchBalance(havenApiRoot, apiKey) {
  const result = await validateKey(havenApiRoot, apiKey);
  if (!result.ok) return result.reason === "empty_balance" ? (result.balance ?? 0) : null;
  return result.balance;
}

// Create a Haven relay bound to one origin + API key. `relay(body, { signal })`
// encrypts, relays, decrypts, and returns { ok, completion, usage, wantStream,
// includeUsage } on success or { ok:false, error } (an OpenAI-style descriptor)
// on failure. A caller-supplied AbortSignal cancels the upstream request (the
// caller sees { ok:false, aborted:true }); each request also gets a `timeoutMs`
// deadline so a hung enclave call can't hang the caller forever (surfaced as 504).
// Requests run concurrently: Haven now serves parallel inference per profile for
// a well-funded key, so overlapping tool-calls fan out. A near-empty key (below
// Haven's ~$2 threshold) is the exception — an overlapping request there gets a
// 409, surfaced verbatim (see classifyHavenError). Each call's { signal, capture }
// is isolated by async context (see ensureFetchWrapper), so concurrent calls —
// same instance or across instances — never touch each other's state.
export function createSecureRelay({ havenApiRoot, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  timeoutMs = Number(timeoutMs); // e.g. opencode.json may hand us a string
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "[haven-relay] timeoutMs must be a positive number of milliseconds.",
    );
  }
  const client = new SecureClient({
    baseURL: `${havenApiRoot}/`,
    attestationBundleURL: havenApiRoot,
  });

  const havenHost = (() => {
    try {
      return new URL(havenApiRoot).host;
    } catch {
      return null;
    }
  })();

  // Strict host match — used to decide which fetches get our abort signal
  // attached. Deliberately stricter than the capture check below: aborting the
  // wrong request would break it, while merely not capturing one is harmless.
  const isHavenUrl = (url) => {
    if (!havenHost) return false;
    try {
      return new URL(url).host === havenHost;
    } catch {
      return false;
    }
  };

  // Run the encrypted chat/completions hop with this call's { signal, capture }
  // scoped to its async context (see ensureFetchWrapper above). Never rejects —
  // returns { upstream } or { err, captured }.
  async function sendWithCapture(upstreamBody, signal) {
    ensureFetchWrapper();
    const ctx = { signal, havenHost, isHavenUrl, captured: null };
    try {
      const upstream = await fetchContext.run(ctx, () =>
        client.fetch("chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
          body: JSON.stringify(upstreamBody),
        }),
      );
      return { upstream };
    } catch (err) {
      return { err, captured: ctx.captured };
    }
  }

  // The enclave answers an EHBP request encrypted to a rotated key with a
  // cleartext 422 problem+json (urn:ietf:params:ehbp:error:key-config). The SDK
  // recovers from that on its own (KeyConfigMismatchError → reset → re-attest →
  // retry) — but only when it sees that exact response. Haven wraps enclave
  // failures as HAVEN_UPSTREAM_ERROR with the real status in details.status,
  // which the SDK reads as a generic error, so a stale key would otherwise wedge
  // this process until restart. Haven doesn't say which kind of 422 it was, so a
  // genuine unprocessable-request 422 costs one harmless extra attempt.
  const isWrappedStaleKeyError = (outcome) =>
    outcome?.captured?.payload?.error_code === "HAVEN_UPSTREAM_ERROR" &&
    outcome.captured.payload.details?.status === 422;

  async function relay(body, { signal } = {}) {
    const { wantStream, includeUsage, upstreamBody } = prepareUpstream(body);

    let timeoutSignal = null;
    const outcome = await (async () => {
      // If the client already went away (e.g. it aborted during body read),
      // don't spend balance on a completion nobody will read.
      if (signal?.aborted) return { abortedBeforeStart: true };
      // Deadline for this request. Not AbortSignal.timeout: its timer is unref'd,
      // so with nothing else keeping the event loop alive the process would exit
      // before the deadline ever fired.
      const timeoutCtrl = new AbortController();
      timeoutSignal = timeoutCtrl.signal;
      const timer = setTimeout(
        () => timeoutCtrl.abort(new DOMException("Haven relay timed out", "TimeoutError")),
        timeoutMs,
      );
      try {
        const effective = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        // The signal cancels the socket in the common case, but a hang can also
        // live in a fetch the signal can't reach (e.g. an attestation started by
        // the startup pre-warm, outside this call's context). Race a backstop so
        // abort/timeout ALWAYS resolves this call; a still-in-flight upstream then
        // finishes ignored (Haven may answer 409 until it does).
        const onAbort = new Promise((resolve) => {
          const done = () =>
            resolve({ err: effective.reason ?? new DOMException("Aborted", "AbortError") });
          if (effective.aborted) return done();
          effective.addEventListener("abort", done, { once: true });
        });
        let result = await Promise.race([sendWithCapture(upstreamBody, effective), onAbort]);
        if (isWrappedStaleKeyError(result) && !effective.aborted) {
          // Run the SDK's own rotation recovery by hand, once, within the same
          // deadline: drop the cached attestation and re-encrypt to the current key.
          client.reset();
          result = await Promise.race([sendWithCapture(upstreamBody, effective), onAbort]);
        }
        return result;
      } finally {
        clearTimeout(timer);
      }
    })();
    const { upstream, err, captured, abortedBeforeStart } = outcome;

    if (abortedBeforeStart || (err && signal?.aborted)) {
      return {
        ok: false,
        aborted: true,
        error: {
          status: 499,
          message: "Request aborted by the client.",
          type: "invalid_request_error",
          code: "request_aborted",
        },
      };
    }
    if (err && timeoutSignal?.aborted) {
      return {
        ok: false,
        error: {
          status: 504,
          message: `Haven relay timed out after ${Math.round(timeoutMs / 1000)}s waiting for the enclave response.`,
          type: "api_error",
          code: "relay_timeout",
        },
      };
    }
    if (err) {
      if (captured) {
        const error = classifyHavenError(captured.status, captured.payload);
        // Haven forwards the enclave's Retry-After on rate limits; keep it on
        // the descriptor so callers can emit it and clients back off properly.
        if (captured.retryAfter) error.retryAfter = captured.retryAfter;
        return { ok: false, error };
      }
      // No captured HTTP response (attestation failure, network, undecodable body).
      // Distinguish the common empty-balance case so the caller gets a clear message.
      const balance = await fetchBalance(havenApiRoot, apiKey);
      if (balance !== null && balance <= 0) {
        return {
          ok: false,
          error: {
            status: 402,
            message: INSUFFICIENT_BALANCE_MSG,
            type: "insufficient_quota",
            code: "insufficient_balance",
          },
        };
      }
      // Deliberately generic: raw SDK error text can carry transport/attestation
      // internals we don't surface to callers.
      return {
        ok: false,
        error: {
          status: 502,
          message: "Haven relay failed: could not reach or verify the enclave.",
          type: "api_error",
          code: null,
        },
      };
    }

    if (!upstream.ok) {
      let payload = {};
      try {
        payload = JSON.parse(await upstream.text());
      } catch {
        /* opaque/undecryptable body — fall back to status alone */
      }
      const error = classifyHavenError(upstream.status, payload);
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) error.retryAfter = retryAfter;
      return { ok: false, error };
    }

    let completion;
    try {
      completion = await upstream.json();
    } catch {
      return {
        ok: false,
        error: {
          status: 502,
          message: "Could not decode the Haven response.",
          type: "api_error",
          code: null,
        },
      };
    }

    return {
      ok: true,
      completion,
      usage: upstream.headers.get(USAGE_HEADER),
      wantStream,
      includeUsage,
    };
  }

  return {
    client,
    relay,
    ready: () => client.ready(),
    validate: () => validateKey(havenApiRoot, apiKey),
  };
}
