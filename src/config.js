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
