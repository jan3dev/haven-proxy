// Config file management for haven-proxy credentials.
// Mirrors the pattern used by the SecureClient SDK's own CLI:
//   - Stored at ~/.haven-proxy/config.json (mode 0600, dir mode 0700)
//   - Written atomically via a tmp file + rename so a crash never corrupts it
//   - Env vars (HAVEN_API_KEY, HAVEN_BASE_URL) override saved values
//   - HAVEN_CONFIG overrides the config file path (useful for testing)
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_BASE_URL, DEFAULT_PORT, opencodeModels } from "./defaults.js";

export { DEFAULT_BASE_URL };

export function configPath() {
  return process.env.HAVEN_CONFIG || join(homedir(), ".haven-proxy", "config.json");
}

// Load config from disk, then apply env var overrides.
// Returns { cfg: { apiKey, baseURL }, path }.
export function loadConfig() {
  const path = configPath();
  let cfg = { apiKey: "", baseURL: DEFAULT_BASE_URL };
  try {
    Object.assign(cfg, JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    if (err.code !== "ENOENT") {
      process.stderr.write(
        `[haven-proxy] warning: cannot read ${path} (${err.message}); falling back to env/defaults\n`,
      );
    }
  }
  // Env vars override config file (flag overrides happen at the call site)
  if (process.env.HAVEN_BASE_URL) cfg.baseURL = process.env.HAVEN_BASE_URL.replace(/\/+$/, "");
  if (process.env.HAVEN_API_KEY) cfg.apiKey = process.env.HAVEN_API_KEY;
  return { cfg, path };
}

// Atomically write config to disk with restricted permissions.
export function saveConfig(cfg) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

// Remove the config file. Returns { path, removed }.
export function deleteConfig() {
  const path = configPath();
  try {
    rmSync(path);
    return { path, removed: true };
  } catch (err) {
    if (err.code === "ENOENT") return { path, removed: false };
    throw err;
  }
}

// Load config and exit with a clear message if no API key is available.
export function requireAuth(flagApiKey) {
  const { cfg, path } = loadConfig();
  const apiKey = flagApiKey || cfg.apiKey;
  if (!apiKey) {
    console.error("[haven-proxy] No API key found. Run one of:");
    console.error("  haven-proxy login --api-key hvn1_…");
    console.error("  export HAVEN_API_KEY=hvn1_…");
    process.exit(1);
  }
  return { ...cfg, apiKey };
}

// Redact a key for display: show prefix + suffix only.
export function redactKey(key) {
  if (!key || key.length <= 12) return "***";
  return key.slice(0, 8) + "…" + key.slice(-4);
}

// --- OpenCode provider registration ----------------------------------------

const OPENCODE_SCHEMA = "https://opencode.ai/config.json";
// The two provider ids we own; everything else in the file is the user's.
const MANAGED_IDS = ["haven", "haven-local"];
// #semver: resolves against release tags, so users always install the latest
// 0.x release instead of whatever is on main. Bump the range at 1.0.
export const HAVEN_NPM_SPEC = "github:jan3dev/haven-proxy#semver:0.x";

// OpenCode resolves its global config through XDG paths rooted at $HOME on EVERY
// platform — there is no %APPDATA% branch, which is why the Windows path this used
// to return was silently ignored. It reads $OPENCODE_CONFIG as an explicit file
// override, else merges <dir>/config.json → opencode.json → opencode.jsonc.
export function opencodeConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

// We target opencode.json because JSON.stringify round-trips it safely, whereas
// rewriting a .jsonc would delete the user's comments.
export function opencodeConfigPath() {
  return process.env.OPENCODE_CONFIG || join(opencodeConfigDir(), "opencode.json");
}

// Blank counts as empty rather than a parse error: OpenCode's own first-run
// bootstrap can leave a 0-byte file behind, and JSON.parse("") throws.
function readJsonDoc(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { doc: {}, existed: false };
    throw err;
  }
  if (!text.trim()) return { doc: {}, existed: true };
  try {
    return { doc: JSON.parse(text), existed: true };
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message})`);
  }
}

function writeJsonDoc(path, doc) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  renameSync(tmp, path);
}

// Only reachable via $OPENCODE_CONFIG. A blank or missing .jsonc is fine to write
// (valid JSON is valid JSONC); one with content has comments we must not destroy.
function assertWritable(path) {
  if (!path.endsWith(".jsonc")) return;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (text.trim()) {
    throw new Error(
      `${path} is a .jsonc file with existing content — add the Haven provider by hand so its comments survive`,
    );
  }
}

// No apiKey in either entry: the in-process provider falls back to
// ~/.haven-proxy/config.json (mode 0600) and the local proxy carries the key
// itself, so nothing secret lands in a config file users share and diff.
function havenProviders(baseURL, proxyPort) {
  const origin = (baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return {
    haven: {
      npm: HAVEN_NPM_SPEC,
      name: "Haven",
      // Only pin baseURL when it isn't the default; the provider resolves it otherwise.
      ...(origin !== DEFAULT_BASE_URL && { options: { baseURL: `${origin}/api/v1/haven` } }),
      models: opencodeModels(),
    },
    "haven-local": {
      npm: "@ai-sdk/openai-compatible",
      name: "Haven (local proxy)",
      options: { baseURL: `http://127.0.0.1:${proxyPort}/v1` },
      models: opencodeModels(),
    },
  };
}

// Compare only what matters: on-disk key order is arbitrary, and extra fields a
// user added by hand are theirs to keep. A leftover options.apiKey from an older
// version counts as a mismatch so the next write scrubs it. Cost counts too, so
// a price change here propagates to existing registrations on the next ensure.
function sameEntry(actual, want) {
  return (
    actual?.npm === want.npm &&
    actual?.options?.baseURL === want.options?.baseURL &&
    !("apiKey" in (actual?.options ?? {})) &&
    Object.keys(actual?.models ?? {}).sort().join() === Object.keys(want.models).sort().join() &&
    Object.entries(want.models).every(
      ([id, m]) =>
        actual.models[id]?.cost?.input === m.cost.input &&
        actual.models[id]?.cost?.output === m.cost.output,
    )
  );
}

// Is our pair of entries present, and does it match what we'd write now?
export function opencodeProviderStatus(baseURL, { proxyPort = DEFAULT_PORT } = {}) {
  const path = opencodeConfigPath();
  let doc;
  try {
    ({ doc } = readJsonDoc(path));
  } catch {
    return { path, registered: false, stale: true }; // malformed: let a write report why
  }
  const want = havenProviders(baseURL, proxyPort);
  const registered = MANAGED_IDS.every((id) => Boolean(doc.provider?.[id]));
  const stale = !registered || MANAGED_IDS.some((id) => !sameEntry(doc.provider[id], want[id]));
  return { path, registered, stale };
}

// Merge both Haven provider entries into the global OpenCode config. Creates the
// file if absent; preserves every other provider and top-level key.
export function saveOpencodeProvider(baseURL, { proxyPort = DEFAULT_PORT } = {}) {
  const path = opencodeConfigPath();
  assertWritable(path);
  const { doc, existed } = readJsonDoc(path);
  const otherProviders = Object.keys(doc.provider || {}).filter((k) => !MANAGED_IDS.includes(k));
  if (!doc.$schema) doc.$schema = OPENCODE_SCHEMA;
  // Spread over the old entries so a plaintext key an older version wrote is dropped.
  doc.provider = { ...doc.provider, ...havenProviders(baseURL, proxyPort) };
  writeJsonDoc(path, doc);
  return { path, existed, otherProviders };
}

// Registration has to be re-assertable: users who installed before the path fix,
// or who wiped their OpenCode config, would otherwise never be repaired.
export function ensureOpencodeProvider(baseURL, { proxyPort = DEFAULT_PORT } = {}) {
  const { path, registered, stale } = opencodeProviderStatus(baseURL, { proxyPort });
  if (registered && !stale) return { path, changed: false };
  return { ...saveOpencodeProvider(baseURL, { proxyPort }), changed: true };
}

// Remove both Haven provider entries from the global OpenCode config on logout.
export function removeOpencodeProvider() {
  const path = opencodeConfigPath();
  const { doc, existed } = readJsonDoc(path);
  if (!existed) return { path, removed: false };
  const present = MANAGED_IDS.filter((id) => doc.provider?.[id]);
  if (!present.length) return { path, removed: false };
  assertWritable(path);
  for (const id of present) delete doc.provider[id];
  if (!Object.keys(doc.provider).length) delete doc.provider;
  writeJsonDoc(path, doc);
  return { path, removed: true };
}

// A successful write can still be overridden: OpenCode merges the global
// config.json → opencode.json → opencode.jsonc (later wins), then project configs
// found walking up from cwd, then $OPENCODE_CONFIG. Return the higher-precedence
// files that also define a "haven" provider, so callers can say so instead of
// implying the write took effect. Pass cwd: null to skip the walk-up (the tray
// app's cwd is wherever Electron was launched, which means nothing).
export function opencodeShadowingConfigs(target = opencodeConfigPath(), { cwd = process.cwd() } = {}) {
  const found = [];
  const consider = (path) => {
    if (!path || resolve(path) === resolve(target)) return;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    // Text match, not a parse: a .jsonc may carry comments and we ship no JSONC parser.
    if (/"haven"\s*:/.test(text)) found.push(path);
  };

  consider(join(opencodeConfigDir(), "opencode.jsonc")); // the only global file that outranks ours
  if (cwd) {
    const names = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"];
    for (let dir = resolve(cwd), prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
      for (const name of names) consider(join(dir, name));
    }
  }
  consider(process.env.OPENCODE_CONFIG);
  return found;
}

// Before the path fix, Windows installs wrote the provider — including a plaintext
// hvn1_ key — to %APPDATA%\opencode\opencode.json, which OpenCode never reads.
// Scrub that dead file rather than leaving a key lying in it.
export function pruneLegacyOpencodeConfig() {
  if (process.platform !== "win32") return { path: null, pruned: false };
  const appdata = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const path = join(appdata, "opencode", "opencode.json");
  if (resolve(path) === resolve(opencodeConfigPath())) return { path, pruned: false };

  let doc, existed;
  try {
    ({ doc, existed } = readJsonDoc(path));
  } catch {
    return { path, pruned: false }; // malformed leftover: not ours to repair
  }
  if (!existed) return { path, pruned: false };
  const present = MANAGED_IDS.filter((id) => doc.provider?.[id]);
  if (!present.length) return { path, pruned: false };

  for (const id of present) delete doc.provider[id];
  if (!Object.keys(doc.provider).length) delete doc.provider;
  if (!Object.keys(doc).some((k) => k !== "$schema")) {
    rmSync(path); // nothing but the schema stub left — drop the file entirely
    try {
      rmdirSync(dirname(path));
    } catch {} // only succeeds while empty, which is the point
  } else {
    writeJsonDoc(path, doc);
  }
  return { path, pruned: true };
}

// Prompt for the API key on stdin, hiding input on a TTY.
export async function promptApiKey() {
  const { createInterface } = await import("node:readline");
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    // Suppress echo so the key isn't visible in the terminal.
    // Set this before writing the prompt so readline's terminal setup is done first —
    // writing before createInterface can be clobbered by readline's raw-mode init on Windows.
    rl._writeToOutput = () => {};
    process.stderr.write("Enter Haven API key (hvn1_…): ");
    rl.question("", (answer) => {
      process.stderr.write("\n");
      rl.close();
      resolve(answer.trim());
    });
    rl.on("error", reject);
  });
}
