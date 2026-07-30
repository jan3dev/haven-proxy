// Tests for the OpenCode provider registration in src/config.js — `npm test`.
//
// Every case redirects the config dir (and %APPDATA%, for the legacy prune) at a
// fresh temp dir, so nothing here can touch the developer's real ~/.config or
// leak state between tests. No network is involved at all.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { MODEL_IDS, DEFAULT_BASE_URL, DEFAULT_PORT } from "../src/defaults.js";
import {
  opencodeConfigDir,
  opencodeConfigPath,
  opencodeProviderStatus,
  saveOpencodeProvider,
  ensureOpencodeProvider,
  removeOpencodeProvider,
  opencodeShadowingConfigs,
  pruneLegacyOpencodeConfig,
} from "../src/config.js";

const ENV_KEYS = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "APPDATA"];
const ids = () => [...MODEL_IDS].sort().join();

let dir;
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "haven-oc-"));
  process.env.OPENCODE_CONFIG_DIR = dir;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const read = () => JSON.parse(readFileSync(opencodeConfigPath(), "utf8"));
const write = (doc) => writeFileSync(opencodeConfigPath(), JSON.stringify(doc, null, 2));

describe("opencodeConfigPath", () => {
  test("honors OPENCODE_CONFIG_DIR", () => {
    assert.equal(opencodeConfigPath(), join(dir, "opencode.json"));
  });

  test("honors XDG_CONFIG_HOME", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = join(dir, "xdg");
    assert.equal(opencodeConfigDir(), join(dir, "xdg", "opencode"));
    assert.equal(opencodeConfigPath(), join(dir, "xdg", "opencode", "opencode.json"));
  });

  test("OPENCODE_CONFIG names an explicit file and outranks the dir", () => {
    process.env.OPENCODE_CONFIG = join(dir, "elsewhere", "custom.json");
    assert.equal(opencodeConfigPath(), join(dir, "elsewhere", "custom.json"));
  });

  // Regression: OpenCode has no %APPDATA% branch, so writing there was a no-op.
  test("defaults to ~/.config/opencode/opencode.json on every platform, never %APPDATA%", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.APPDATA = join(dir, "Roaming");
    assert.equal(opencodeConfigPath(), join(homedir(), ".config", "opencode", "opencode.json"));
    assert.ok(!opencodeConfigPath().includes("AppData"));
  });

  test("refuses to rewrite a .jsonc that has content", () => {
    const jsonc = join(dir, "opencode.jsonc");
    writeFileSync(jsonc, '{\n  // keep me\n  "provider": {}\n}\n');
    process.env.OPENCODE_CONFIG = jsonc;
    assert.throws(() => saveOpencodeProvider(DEFAULT_BASE_URL), /\.jsonc file with existing content/);
    assert.match(readFileSync(jsonc, "utf8"), /keep me/);
  });

  test("a blank .jsonc is safe to write — valid JSON is valid JSONC", () => {
    const jsonc = join(dir, "opencode.jsonc");
    writeFileSync(jsonc, "   \n");
    process.env.OPENCODE_CONFIG = jsonc;
    saveOpencodeProvider(DEFAULT_BASE_URL);
    assert.ok(JSON.parse(readFileSync(jsonc, "utf8")).provider.haven);
  });
});

describe("saveOpencodeProvider", () => {
  test("creates the file with $schema and both provider entries", () => {
    const { path, existed, otherProviders } = saveOpencodeProvider(DEFAULT_BASE_URL);
    assert.equal(path, join(dir, "opencode.json"));
    assert.equal(existed, false);
    assert.deepEqual(otherProviders, []);

    const doc = read();
    assert.equal(doc.$schema, "https://opencode.ai/config.json");
    assert.equal(doc.provider.haven.npm, "github:jan3dev/haven-proxy");
    assert.equal(doc.provider.haven.name, "Haven");
    assert.equal(doc.provider["haven-local"].npm, "@ai-sdk/openai-compatible");
    assert.equal(
      doc.provider["haven-local"].options.baseURL,
      `http://127.0.0.1:${DEFAULT_PORT}/v1`,
    );
    for (const id of ["haven", "haven-local"]) {
      assert.equal(Object.keys(doc.provider[id].models).sort().join(), ids());
    }
  });

  test("writes a cost block (USD per 1M tokens) for every model", () => {
    saveOpencodeProvider(DEFAULT_BASE_URL);
    const doc = read();
    for (const id of ["haven", "haven-local"]) {
      for (const model of Object.values(doc.provider[id].models)) {
        assert.equal(typeof model.cost.input, "number");
        assert.equal(typeof model.cost.output, "number");
      }
    }
  });

  // Trust boundary: the key lives in ~/.haven-proxy/config.json (0600), nowhere else.
  test("never writes an API key into the OpenCode config", () => {
    saveOpencodeProvider(DEFAULT_BASE_URL);
    const raw = readFileSync(opencodeConfigPath(), "utf8");
    assert.ok(!raw.includes("apiKey"));
    assert.ok(!raw.includes("hvn1_"));
  });

  test("omits options.baseURL at the default origin, pins it otherwise", () => {
    saveOpencodeProvider(DEFAULT_BASE_URL);
    assert.equal(read().provider.haven.options, undefined);

    saveOpencodeProvider("https://staging.example.com/");
    assert.equal(
      read().provider.haven.options.baseURL,
      "https://staging.example.com/api/v1/haven",
    );
  });

  test("uses the given proxy port for the haven-local entry", () => {
    saveOpencodeProvider(DEFAULT_BASE_URL, { proxyPort: 4444 });
    assert.equal(read().provider["haven-local"].options.baseURL, "http://127.0.0.1:4444/v1");
  });

  test("preserves other providers, other top-level keys and an existing $schema", () => {
    write({
      $schema: "https://example.com/custom.json",
      theme: "tokyonight",
      provider: { openai: { models: { "gpt-4o": {} } } },
    });
    const { existed, otherProviders } = saveOpencodeProvider(DEFAULT_BASE_URL);
    assert.equal(existed, true);
    assert.deepEqual(otherProviders, ["openai"]);

    const doc = read();
    assert.equal(doc.$schema, "https://example.com/custom.json");
    assert.equal(doc.theme, "tokyonight");
    assert.ok(doc.provider.openai.models["gpt-4o"]);
    assert.ok(doc.provider.haven);
  });

  test("treats a blank existing file as empty instead of throwing", () => {
    writeFileSync(opencodeConfigPath(), "  \n\t");
    assert.doesNotThrow(() => saveOpencodeProvider(DEFAULT_BASE_URL));
    assert.ok(read().provider.haven);
  });

  test("reports the path when the existing file is malformed", () => {
    writeFileSync(opencodeConfigPath(), "{ not json");
    assert.throws(
      () => saveOpencodeProvider(DEFAULT_BASE_URL),
      (err) => err.message.includes(opencodeConfigPath()) && /not valid JSON/.test(err.message),
    );
  });
});

describe("ensureOpencodeProvider", () => {
  test("writes once, then reports no change", () => {
    assert.equal(ensureOpencodeProvider(DEFAULT_BASE_URL).changed, true);
    assert.equal(ensureOpencodeProvider(DEFAULT_BASE_URL).changed, false);
  });

  test("re-registers when an entry is missing", () => {
    saveOpencodeProvider(DEFAULT_BASE_URL);
    const doc = read();
    delete doc.provider["haven-local"];
    write(doc);

    assert.equal(opencodeProviderStatus(DEFAULT_BASE_URL).registered, false);
    assert.equal(ensureOpencodeProvider(DEFAULT_BASE_URL).changed, true);
    assert.ok(read().provider["haven-local"]);
  });

  test("scrubs a plaintext key left by an older version", () => {
    write({
      provider: {
        haven: {
          npm: "github:jan3dev/haven-proxy",
          options: { apiKey: "hvn1_leftover_key" },
          models: Object.fromEntries(MODEL_IDS.map((id) => [id, {}])),
        },
        "haven-local": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${DEFAULT_PORT}/v1` },
          models: Object.fromEntries(MODEL_IDS.map((id) => [id, {}])),
        },
      },
    });
    const status = opencodeProviderStatus(DEFAULT_BASE_URL);
    assert.equal(status.registered, true);
    assert.equal(status.stale, true); // the key alone makes it stale

    assert.equal(ensureOpencodeProvider(DEFAULT_BASE_URL).changed, true);
    assert.ok(!readFileSync(opencodeConfigPath(), "utf8").includes("hvn1_"));
  });

  test("re-registers when the pinned baseURL no longer matches", () => {
    saveOpencodeProvider("https://staging.example.com");
    assert.equal(ensureOpencodeProvider("https://staging.example.com").changed, false);
    assert.equal(ensureOpencodeProvider("https://other.example.com").changed, true);
    assert.equal(read().provider.haven.options.baseURL, "https://other.example.com/api/v1/haven");
  });
});

describe("removeOpencodeProvider", () => {
  test("removes both entries and keeps everything else", () => {
    write({ provider: { openai: { models: {} } }, theme: "tokyonight" });
    saveOpencodeProvider(DEFAULT_BASE_URL);

    const { removed } = removeOpencodeProvider();
    assert.equal(removed, true);
    const doc = read();
    assert.equal(doc.provider.haven, undefined);
    assert.equal(doc.provider["haven-local"], undefined);
    assert.ok(doc.provider.openai);
    assert.equal(doc.theme, "tokyonight");
  });

  test("drops an emptied provider block", () => {
    saveOpencodeProvider(DEFAULT_BASE_URL);
    removeOpencodeProvider();
    assert.equal("provider" in read(), false);
  });

  test("is a no-op when there is nothing of ours to remove", () => {
    assert.equal(removeOpencodeProvider().removed, false); // no file at all
    write({ provider: { openai: {} } });
    assert.equal(removeOpencodeProvider().removed, false);
  });
});

describe("opencodeShadowingConfigs", () => {
  const target = () => opencodeConfigPath();

  test("reports a global opencode.jsonc that also defines haven", () => {
    writeFileSync(join(dir, "opencode.jsonc"), '{ "provider": { "haven": {} } }');
    assert.deepEqual(opencodeShadowingConfigs(target(), { cwd: null }), [
      join(dir, "opencode.jsonc"),
    ]);
  });

  test("ignores a blank or haven-free opencode.jsonc", () => {
    writeFileSync(join(dir, "opencode.jsonc"), "");
    assert.deepEqual(opencodeShadowingConfigs(target(), { cwd: null }), []);
    writeFileSync(join(dir, "opencode.jsonc"), '{ "provider": { "openai": {} } }');
    assert.deepEqual(opencodeShadowingConfigs(target(), { cwd: null }), []);
  });

  test("never reports the target itself", () => {
    saveOpencodeProvider(DEFAULT_BASE_URL);
    assert.deepEqual(opencodeShadowingConfigs(target(), { cwd: null }), []);
  });

  test("finds a project config by walking up from cwd", () => {
    const nested = join(dir, "project", "src", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, "project", "opencode.json"), '{ "provider": { "haven": {} } }');
    assert.deepEqual(opencodeShadowingConfigs(target(), { cwd: nested }), [
      join(dir, "project", "opencode.json"),
    ]);
  });

  test("finds a project config in a .opencode subdir", () => {
    const project = join(dir, "project2");
    mkdirSync(join(project, ".opencode"), { recursive: true });
    writeFileSync(join(project, ".opencode", "opencode.jsonc"), '{ "provider": { "haven": {} } }');
    assert.deepEqual(opencodeShadowingConfigs(target(), { cwd: project }), [
      join(project, ".opencode", "opencode.jsonc"),
    ]);
  });
});

describe("pruneLegacyOpencodeConfig", () => {
  const legacyPath = () => join(process.env.APPDATA, "opencode", "opencode.json");
  const writeLegacy = (doc) => {
    mkdirSync(join(process.env.APPDATA, "opencode"), { recursive: true });
    writeFileSync(legacyPath(), JSON.stringify(doc, null, 2));
  };

  beforeEach(() => {
    process.env.APPDATA = join(dir, "Roaming");
  });

  const win32Only = { skip: process.platform !== "win32" && "win32-only migration" };

  test("deletes the dead file when it held only our entries", win32Only, () => {
    writeLegacy({
      $schema: "https://opencode.ai/config.json",
      provider: { haven: { options: { apiKey: "hvn1_leftover_key" } } },
    });
    const { pruned } = pruneLegacyOpencodeConfig();
    assert.equal(pruned, true);
    assert.equal(existsSync(legacyPath()), false);
  });

  test("keeps the file but drops our entries when it holds another provider", win32Only, () => {
    writeLegacy({ provider: { haven: {}, "haven-local": {}, openai: { models: {} } } });
    assert.equal(pruneLegacyOpencodeConfig().pruned, true);

    const doc = JSON.parse(readFileSync(legacyPath(), "utf8"));
    assert.equal(doc.provider.haven, undefined);
    assert.equal(doc.provider["haven-local"], undefined);
    assert.ok(doc.provider.openai);
  });

  test("is a no-op when there is no legacy file or nothing of ours in it", win32Only, () => {
    assert.equal(pruneLegacyOpencodeConfig().pruned, false);
    writeLegacy({ provider: { openai: {} } });
    assert.equal(pruneLegacyOpencodeConfig().pruned, false);
    assert.equal(existsSync(legacyPath()), true);
  });
});
