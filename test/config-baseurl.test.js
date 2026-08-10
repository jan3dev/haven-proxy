// Tests for normalizeBaseURL in src/config.js — `npm test`.
//
// This is the one guardrail in front of a user-typed backend origin, shared by the
// CLI's `login --base-url` and the tray app's settings window. Pure string work:
// no config file, no network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseURL, DEFAULT_BASE_URL } from "../src/config.js";

describe("normalizeBaseURL", () => {
  test("blank input falls back to the default backend", () => {
    for (const input of ["", "   ", null, undefined]) {
      assert.deepEqual(normalizeBaseURL(input), { baseURL: DEFAULT_BASE_URL });
    }
  });

  test("keeps a plain https origin, including a port", () => {
    assert.deepEqual(normalizeBaseURL("https://ankara.aquabtc.com"), {
      baseURL: "https://ankara.aquabtc.com",
    });
    assert.deepEqual(normalizeBaseURL("https://ankara-stg.example:8443"), {
      baseURL: "https://ankara-stg.example:8443",
    });
  });

  test("trims whitespace and strips trailing slashes", () => {
    assert.deepEqual(normalizeBaseURL("  https://ankara.aquabtc.com///  "), {
      baseURL: "https://ankara.aquabtc.com",
    });
  });

  test("rejects a non-https scheme", () => {
    for (const input of ["http://ankara.aquabtc.com", "ftp://host", "http://127.0.0.1:8000"]) {
      assert.match(normalizeBaseURL(input).error, /https:\/\//);
      assert.equal(normalizeBaseURL(input).baseURL, undefined);
    }
  });

  test("rejects input that is not a URL at all", () => {
    for (const input of ["garbage", "ankara.aquabtc.com", "://"]) {
      assert.match(normalizeBaseURL(input).error, /not a valid URL/);
    }
  });

  // Callers append /api/v1/haven themselves, so a pasted API URL would double up.
  test("rejects an origin carrying a path, query or fragment", () => {
    for (const input of [
      "https://ankara.aquabtc.com/api/v1/haven",
      "https://ankara.aquabtc.com/?a=1",
      "https://ankara.aquabtc.com/#x",
    ]) {
      const { error } = normalizeBaseURL(input);
      assert.match(error, /origin only/);
      assert.match(error, /https:\/\/ankara\.aquabtc\.com/);
    }
  });
});
