// Config file management for haven-proxy credentials.
// Mirrors the pattern used by the Tinfoil CLI:
//   - Stored at ~/.haven-proxy/config.json (mode 0600, dir mode 0700)
//   - Written atomically via a tmp file + rename so a crash never corrupts it
//   - Env vars (HAVEN_API_KEY, HAVEN_BASE_URL) override saved values
//   - HAVEN_CONFIG overrides the config file path (useful for testing)
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_BASE_URL = "https://ankara.aquabtc.com";

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

// Platform-appropriate path for the global OpenCode config.
// Windows: %APPDATA%\opencode\opencode.json
// Others:  ~/.config/opencode/opencode.json
export function opencodeConfigPath() {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appdata, "opencode", "opencode.json");
  }
  return join(homedir(), ".config", "opencode", "opencode.json");
}

// Merge the Haven provider entry into the global OpenCode config.
// Creates the file if it doesn't exist; preserves all other providers/keys.
// No API key is written — the provider falls back to ~/.haven-proxy/config.json.
export function saveOpencodeProvider(apiKey, baseURL) {
  const path = opencodeConfigPath();
  let doc = {};
  let existed = false;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
    existed = true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const otherProviders = Object.keys(doc.provider || {}).filter((k) => k !== "haven");
  if (!doc.provider) doc.provider = {};
  doc.provider.haven = {
    npm: "github:jan3dev/haven-proxy",
    name: "Haven",
    options: {
      apiKey,
      ...(baseURL !== DEFAULT_BASE_URL && { baseURL: `${baseURL}/api/v1/haven` }),
    },
    models: {
      "gpt-oss-120b":  { name: "GPT-OSS 120B (Haven)",  limit: { context: 131072, output: 32768 } },
      "kimi-k2-6":     { name: "Kimi K2.6 (Haven)",     limit: { context: 200000, output: 65536 } },
      "glm-5-2":       { name: "GLM-5.2 (Haven)",        limit: { context: 200000, output: 65536 } },
      "gemma4-31b":    { name: "Gemma 4 31B (Haven)",    limit: { context: 131072, output: 32768 } },
      "llama3-3-70b":  { name: "Llama 3.3 70B (Haven)",  limit: { context: 131072, output: 32768 } },
      "qwen3-vl-30b":  { name: "Qwen3-VL 30B (Haven)",   limit: { context: 131072, output: 32768 } },
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  renameSync(tmp, path);
  return { path, existed, otherProviders };
}

// Remove the Haven provider entry from the global OpenCode config on logout.
export function removeOpencodeProvider() {
  const path = opencodeConfigPath();
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (doc.provider?.haven) {
      delete doc.provider.haven;
      if (Object.keys(doc.provider).length === 0) delete doc.provider;
      const tmp = path + ".tmp";
      writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
      renameSync(tmp, path);
      return { path, removed: true };
    }
    return { path, removed: false };
  } catch (err) {
    if (err.code === "ENOENT") return { path, removed: false };
    throw err;
  }
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
