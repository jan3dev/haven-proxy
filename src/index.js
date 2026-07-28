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
import { parseArgs } from "node:util";

// Load .env from cwd so `haven-proxy` picks up the same variables as `npm start`
// (which passes --env-file=.env explicitly). On Windows there is no shell-level
// equivalent, so without this the binary silently starts with no key.
try { process.loadEnvFile(); } catch (e) { if (e?.code !== "ENOENT") throw e; }
import { DEFAULT_TIMEOUT_MS, validateKey } from "./relay.js";
import { loadConfig, saveConfig, deleteConfig, requireAuth, redactKey, promptApiKey, DEFAULT_BASE_URL, opencodeConfigPath, saveOpencodeProvider, removeOpencodeProvider } from "./config.js";
import { startDaemon, stopDaemon, statusDaemon, startupCommand } from "./daemon.js";
import { createProxyServer } from "./server.js";

const HELP = `
haven-proxy — OpenAI-compatible localhost proxy for the Haven encrypted inference relay

Usage:
  haven-proxy [command] [options]
  npm start                       (loads .env automatically, then starts proxy)

Commands:
  login                           Save Haven API key to ~/.haven-proxy/config.json
  logout                          Remove saved credentials
  validate                        Check API key validity and account balance
  serve                           Start the proxy in the foreground (default)
  start                           Start the proxy in the background (logs: ~/.haven-proxy/proxy.log)
  stop                            Stop the background proxy
  status                          Show background proxy status and account balance
  startup on|off                  Start the proxy automatically at login (Windows; no arg: show state)
  help                            Show this help

  (no command)                    Start the proxy in the foreground (same as serve)

  start accepts the same options as serve and passes them through. Prefer
  \`login\` over --api-key with start — flags are visible in process listings.

Options (serve / start):
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

// The whole dispatch lives in main() rather than at module top level: the SEA
// build (scripts/build-sea.mjs) bundles this file to CommonJS, where top-level
// await is a syntax error. Branch bodies keep their original indentation.
async function main() {

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

// --- start (background) ---
else if (subcommand === "start") {
  // Same options as serve — parsed only to learn where to probe /health;
  // the flags themselves are forwarded to the child verbatim.
  const { values } = parseArgs({
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
  if (values.help) {
    console.log(HELP);
    process.exitCode = 0;
  } else {
    process.exitCode = await startDaemon({
      port: Number(values.port || process.env.PORT || 3301),
      host: values.host || process.env.HOST || "127.0.0.1",
      passthroughArgs: subArgs,
    });
  }
}

// --- stop / status / startup ---
else if (subcommand === "stop") {
  process.exitCode = await stopDaemon();
}
else if (subcommand === "status") {
  process.exitCode = await statusDaemon();
}
else if (subcommand === "startup") {
  process.exitCode = await startupCommand(subArgs[0]);
}

// --- unknown command ---
else if (subcommand && subcommand !== "serve") {
  console.error(`[haven-proxy] unknown command "${subcommand}" — run \`haven-proxy help\`.`);
  process.exitCode = 1;
}

else {

// --- serve: start proxy in the foreground (default) ---
// Server construction lives in src/server.js (shared with the Electron tray
// app); this branch only resolves flags/env/config and maps failures to
// console + exit codes.
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
else {
  // Resolution order: flag > env var > config file > hardcoded default
  const cfg = requireAuth(flags["api-key"]);
  const apiKey = flags["api-key"] || cfg.apiKey;
  const baseURL = (flags["base-url"] || cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const host = flags["host"] || process.env.HOST || "127.0.0.1";
  const port = Number(flags["port"] || process.env.PORT || 3301);
  const allowRemote = flags["allow-remote"] || process.env.HAVEN_ALLOW_REMOTE === "1";

  const modelsRaw = flags["models"] || process.env.HAVEN_MODELS;
  const models = modelsRaw
    ? modelsRaw.split(",").map((m) => m.trim()).filter(Boolean)
    : undefined; // server default

  // Per-request upstream deadline (ms). Responses are buffered (no true streaming),
  // so long generations legitimately take minutes — keep this generous.
  const timeoutRaw = flags["timeout"] || process.env.HAVEN_TIMEOUT_MS;
  const timeoutMs = Number(timeoutRaw || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(
      `[haven-proxy] --timeout / HAVEN_TIMEOUT_MS must be a positive number of milliseconds, got "${timeoutRaw}".`,
    );
    process.exit(1);
  }

  const proxy = createProxyServer({ apiKey, baseURL, models, timeoutMs });
  await proxy.listen({ port, host, allowRemote }).catch((err) => {
    console.error(`[haven-proxy] ${err.message}`);
    process.exit(1);
  });
}

} // end else (start proxy)

} // end main()

main().catch((err) => {
  console.error(`[haven-proxy] ${err?.message || err}`);
  process.exitCode = 1;
});
