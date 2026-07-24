// Tests for the relay core (src/relay.js) — run with `npm test` (node --test).
//
// The integration tests stand up a local HTTP server that plays Ankara and stub
// SecureClient.fetch to POST through the (wrapped) global fetch, throwing on
// non-2xx like the SDK's missing-nonce protocol error does. That exercises the
// real capture/classify/retry paths without enclaves or attestation.
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  classifyHavenError,
  prepareUpstream,
  sseLinesFor,
  createSecureRelay,
  INSUFFICIENT_BALANCE_MSG,
} from "../src/relay.js";

const envelope = (status, extraDetails = {}) => ({
  error_code: "HAVEN_UPSTREAM_ERROR",
  message: "External API error",
  details: { status, ...extraDetails },
});

describe("classifyHavenError", () => {
  test("wrapped upstream 429 → 429 upstream_rate_limited (old and new Haven status)", () => {
    for (const havenStatus of [502, 429]) {
      const err = classifyHavenError(havenStatus, envelope(429));
      assert.equal(err.status, 429);
      assert.equal(err.code, "upstream_rate_limited");
      assert.equal(err.type, "rate_limit_error");
    }
  });

  test("wrapped upstream 422 → enclave_key_mismatch", () => {
    const err = classifyHavenError(502, envelope(422));
    assert.equal(err.status, 502);
    assert.equal(err.code, "enclave_key_mismatch");
  });

  test("verbatim EHBP problem+json → enclave_key_mismatch with problem title", () => {
    const err = classifyHavenError(422, {
      type: "urn:ietf:params:ehbp:error:key-config",
      title: "key configuration mismatch",
    });
    assert.equal(err.status, 502);
    assert.equal(err.code, "enclave_key_mismatch");
    assert.match(err.message, /key configuration mismatch/);
  });

  test("wrapped 400/404 with upstream_message → forwarded status and message", () => {
    for (const status of [400, 404]) {
      const err = classifyHavenError(502, envelope(status, { upstream_message: "model not found" }));
      assert.equal(err.status, status);
      assert.equal(err.code, "upstream_rejected");
      assert.equal(err.message, "model not found");
      assert.equal(err.type, "invalid_request_error");
    }
  });

  test("wrapped 404 without upstream_message → generic 502", () => {
    const err = classifyHavenError(502, envelope(404));
    assert.equal(err.status, 502);
    assert.equal(err.code, "HAVEN_UPSTREAM_ERROR");
  });

  test("Haven's own statuses keep their meanings", () => {
    assert.equal(classifyHavenError(400, {}).code, "insufficient_balance");
    assert.equal(classifyHavenError(402, {}).code, "insufficient_balance");
    assert.equal(classifyHavenError(400, {}).message, INSUFFICIENT_BALANCE_MSG);
    assert.equal(classifyHavenError(401, {}).code, "invalid_api_key");
    assert.equal(classifyHavenError(409, {}).code, "request_in_progress");
    assert.equal(classifyHavenError(418, {}).status, 502);
    assert.equal(classifyHavenError(503, {}).status, 503);
  });
});

describe("prepareUpstream", () => {
  test("always buffers upstream; preserves the caller's stream intent", () => {
    const { wantStream, includeUsage, upstreamBody } = prepareUpstream({
      model: "m",
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.equal(wantStream, true);
    assert.equal(includeUsage, true);
    assert.equal(upstreamBody.stream, false);
    assert.equal("stream_options" in upstreamBody, false);
  });

  test("non-streaming request passes through unstreamed", () => {
    const { wantStream, includeUsage } = prepareUpstream({ model: "m" });
    assert.equal(wantStream, false);
    assert.equal(includeUsage, false);
  });
});

describe("sseLinesFor", () => {
  test("re-emits a buffered completion losslessly and terminates with [DONE]", () => {
    const lines = sseLinesFor(
      {
        id: "c1",
        created: 1,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "hello world" }, finish_reason: "stop" }],
      },
      false,
    );
    const deltas = lines
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)));
    const text = deltas.map((d) => d.choices[0]?.delta?.content ?? "").join("");
    assert.equal(text, "hello world");
    assert.equal(deltas.at(-1).choices[0].finish_reason, "stop");
    assert.equal(lines.at(-1), "data: [DONE]\n\n");
  });
});

describe("relay integration (fake Ankara + stubbed SecureClient)", () => {
  const COMPLETION = {
    id: "cmpl-1",
    object: "chat.completion",
    created: 1,
    model: "gpt-oss-120b",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  };

  let server;
  let relayObj;
  let mode; // per-test server behaviour
  let hits;
  let resets;

  before(async () => {
    server = createServer((req, res) => {
      hits++;
      switch (mode === "recover" && hits > 1 ? "ok" : mode) {
        case "recover": // first hit: pre-passthrough Haven wrapping the EHBP 422
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify(envelope(422)));
          break;
        case "always422":
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify(envelope(422)));
          break;
        case "problem422": // post-passthrough Haven relaying the EHBP signal verbatim
          res.writeHead(422, { "Content-Type": "application/problem+json" });
          res.end(JSON.stringify({ type: "urn:ietf:params:ehbp:error:key-config", title: "stale key" }));
          break;
        case "rate429":
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "30" });
          res.end(JSON.stringify(envelope(429)));
          break;
        case "balance400":
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error_code: "INSUFFICIENT_BALANCE", message: "empty" }));
          break;
        default:
          res.writeHead(200, {
            "Content-Type": "application/json",
            "X-Tinfoil-Usage-Metrics": "prompt=1,completion=1,total=2",
          });
          res.end(JSON.stringify(COMPLETION));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    // SecureClient's constructor insists on HTTPS, but the relay's capture and
    // signal logic match on host only — so build the relay against an https
    // root and have the stub POST to the plain-http server on the same port.
    const root = `https://127.0.0.1:${port}/api/v1/haven`;
    const httpRoot = `http://127.0.0.1:${port}/api/v1/haven`;
    relayObj = createSecureRelay({ havenApiRoot: root, apiKey: "hvn1_test" });
    Object.defineProperty(relayObj.client, "fetch", {
      value: async (path, init) => {
        const res = await globalThis.fetch(`${httpRoot}/${path}`, init);
        if (!res.ok) throw new Error("Missing Ehbp-Response-Nonce header");
        return res;
      },
    });
    Object.defineProperty(relayObj.client, "reset", {
      value: () => {
        resets++;
      },
    });
  });

  after(() => server.close());

  beforeEach(() => {
    hits = 0;
    resets = 0;
  });

  test("wrapped stale-key 422 → reset, retry once, succeed", async () => {
    mode = "recover";
    const out = await relayObj.relay({ model: "gpt-oss-120b", messages: [] });
    assert.equal(out.ok, true);
    assert.equal(resets, 1);
    assert.equal(hits, 2);
  });

  test("persistent wrapped 422 → exactly one retry, enclave_key_mismatch", async () => {
    mode = "always422";
    const out = await relayObj.relay({ model: "gpt-oss-120b", messages: [] });
    assert.equal(out.ok, false);
    assert.equal(resets, 1);
    assert.equal(hits, 2);
    assert.equal(out.error.code, "enclave_key_mismatch");
  });

  test("verbatim EHBP 422 → no relay-level retry (the SDK owns that recovery)", async () => {
    mode = "problem422";
    const out = await relayObj.relay({ model: "gpt-oss-120b", messages: [] });
    assert.equal(out.ok, false);
    assert.equal(resets, 0);
    assert.equal(hits, 1);
    assert.equal(out.error.code, "enclave_key_mismatch");
    assert.match(out.error.message, /stale key/);
  });

  test("429 with Retry-After → descriptor carries retryAfter", async () => {
    mode = "rate429";
    const out = await relayObj.relay({ model: "gpt-oss-120b", messages: [] });
    assert.equal(out.ok, false);
    assert.equal(out.error.status, 429);
    assert.equal(out.error.code, "upstream_rate_limited");
    assert.equal(out.error.retryAfter, "30");
    assert.equal(hits, 1);
  });

  test("unrelated error → untouched path, no reset", async () => {
    mode = "balance400";
    const out = await relayObj.relay({ model: "gpt-oss-120b", messages: [] });
    assert.equal(out.ok, false);
    assert.equal(resets, 0);
    assert.equal(hits, 1);
    assert.equal(out.error.code, "insufficient_balance");
  });

  test("success → completion and usage header round-trip", async () => {
    mode = "ok";
    const out = await relayObj.relay({ model: "gpt-oss-120b", messages: [], stream: true });
    assert.equal(out.ok, true);
    assert.equal(out.completion.choices[0].message.content, "hi");
    assert.equal(out.usage, "prompt=1,completion=1,total=2");
    assert.equal(out.wantStream, true);
  });
});
