// Background-process management for the haven-proxy CLI.
//
//   start   — re-spawn this same program detached + hidden, logging to
//             ~/.haven-proxy/proxy.log, state in ~/.haven-proxy/proxy.json
//   stop    — kill the background process recorded in proxy.json
//   status  — liveness (pid + /health) plus key balance
//   startup — register/unregister launch-at-login (Windows Startup folder;
//             macOS/Linux are follow-ups)
//
// "Running" always means pid alive AND /health answering — the health probe
// filters both stale state files and PID reuse by unrelated processes.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { configPath, loadConfig, redactKey } from "./config.js";
import { validateKey } from "./relay.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate to proxy.log.old above this

// Daemon state lives next to the config file so HAVEN_CONFIG redirects both.
function stateDir() {
  return dirname(configPath());
}
function statePath() {
  return join(stateDir(), "proxy.json");
}
export function logPath() {
  return join(stateDir(), "proxy.log");
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const tmp = statePath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, statePath());
}

function clearState() {
  rmSync(statePath(), { force: true });
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // alive but owned by someone else
  }
}

async function isHealthy(port, host = "127.0.0.1") {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// In a SEA binary process.execPath IS the program and user args start at
// argv[2]; under plain node, argv[1] is the script to re-run.
async function isSeaBinary() {
  try {
    // node:sea exists since 20.12; guard anyway for exotic runtimes.
    const { isSea } = await import("node:sea");
    return isSea();
  } catch {
    return false;
  }
}

async function selfSpawnArgs(rest) {
  return (await isSeaBinary()) ? ["serve", ...rest] : [process.argv[1], "serve", ...rest];
}

// Start the proxy in the background. `port`/`host` are what the child will
// bind (used for the readiness probe); `passthroughArgs` are forwarded to
// `serve` verbatim. Returns a process exit code.
export async function startDaemon({ port, host = "127.0.0.1", passthroughArgs = [] }) {
  const existing = readState();
  if (existing && isPidAlive(existing.pid) && (await isHealthy(existing.port, existing.host))) {
    console.log(`[haven-proxy] already running (pid ${existing.pid}, http://${existing.host}:${existing.port}/v1)`);
    return 0;
  }
  clearState();

  // Fail fast with the same guidance serve would log — but here, not buried in the log file.
  const { cfg } = loadConfig();
  const hasKeyFlag = passthroughArgs.some((a) => a === "-k" || a === "--api-key" || a.startsWith("--api-key="));
  if (!cfg.apiKey && !hasKeyFlag) {
    console.error("[haven-proxy] No API key found. Run `haven-proxy login` first.");
    return 1;
  }

  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const log = logPath();
  try {
    if (statSync(log).size > MAX_LOG_BYTES) renameSync(log, log + ".old");
  } catch {} // no log yet
  const logFd = openSync(log, "a");

  const child = spawn(process.execPath, await selfSpawnArgs(passthroughArgs), {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  let died = false;
  child.on("exit", () => {
    died = true;
  });
  child.unref();
  closeSync(logFd); // child holds its own handle

  // Wait for the server to actually answer before declaring success.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (died) break;
    if (await isHealthy(port, host)) {
      writeState({ pid: child.pid, port, host, startedAt: new Date().toISOString() });
      console.log(`[haven-proxy] started in background (pid ${child.pid})`);
      console.log(`[haven-proxy] endpoint: http://${host}:${port}/v1`);
      console.log(`[haven-proxy] logs:     ${log}`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  console.error(`[haven-proxy] proxy did not become healthy on http://${host}:${port} — see ${log}`);
  printLogTail(log);
  if (!died && isPidAlive(child.pid)) process.kill(child.pid);
  return 1;
}

export async function stopDaemon() {
  const state = readState();
  if (!state || !isPidAlive(state.pid)) {
    console.log("[haven-proxy] not running");
    clearState();
    return 0;
  }
  process.kill(state.pid); // abrupt is fine: stateless server, atomic config writes
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isPidAlive(state.pid)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isPidAlive(state.pid)) {
    console.error(`[haven-proxy] pid ${state.pid} did not exit — kill it manually`);
    return 1;
  }
  clearState();
  console.log(`[haven-proxy] stopped (pid ${state.pid})`);
  return 0;
}

export async function statusDaemon() {
  const state = readState();
  const alive = state && isPidAlive(state.pid);
  const healthy = alive && (await isHealthy(state.port, state.host));
  if (!healthy) {
    console.log("[haven-proxy] status:   not running");
    if (state && !alive) clearState();
  } else {
    console.log(`[haven-proxy] status:   running (pid ${state.pid}, since ${state.startedAt})`);
    console.log(`[haven-proxy] endpoint: http://${state.host}:${state.port}/v1`);
    console.log(`[haven-proxy] logs:     ${logPath()}`);
  }

  const { cfg } = loadConfig();
  if (!cfg.apiKey) {
    console.log("[haven-proxy] key:      none saved — run `haven-proxy login`");
    return healthy ? 0 : 1;
  }
  console.log(`[haven-proxy] key:      ${redactKey(cfg.apiKey)}`);
  const havenApiRoot = `${cfg.baseURL.replace(/\/+$/, "")}/api/v1/haven`;
  const result = await validateKey(havenApiRoot, cfg.apiKey);
  if (result.ok) {
    console.log(`[haven-proxy] balance:  $${result.balance.toFixed(2)} ✓`);
  } else if (result.reason === "invalid_key") {
    console.log("[haven-proxy] balance:  key is INVALID (401)");
  } else if (result.reason === "empty_balance") {
    console.log("[haven-proxy] balance:  $0.00 — top up before sending requests");
  } else {
    console.log("[haven-proxy] balance:  could not reach Haven account endpoint");
  }
  return healthy ? 0 : 1;
}

// --- launch at login -------------------------------------------------------

function windowsStartupDir() {
  const appdata = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

// Exported so the tray app can warn when both it and the CLI launcher would
// auto-start a proxy at login.
export function windowsLauncherPath() {
  return join(windowsStartupDir(), "haven-proxy.vbs");
}

// The Startup folder runs the .vbs via wscript, and window style 0 means not
// even a transient console flash — an HKCU Run entry pointing at a
// console-subsystem exe would flash a window on every login.
async function windowsLauncherScript() {
  // Inside a VBS string literal, "" is an escaped quote.
  const q = (p) => `""${p}""`;
  const cmd = (await isSeaBinary())
    ? `${q(process.execPath)} start`
    : `${q(process.execPath)} ${q(process.argv[1])} start`;
  return `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`;
}

export async function startupCommand(action) {
  if (action && action !== "on" && action !== "off") {
    console.error(`[haven-proxy] unknown startup action "${action}" — use: startup on|off`);
    return 1;
  }
  if (process.platform !== "win32") {
    if (!action) {
      console.log("[haven-proxy] startup:  not supported on this platform yet (Windows only)");
      return 0;
    }
    console.error("[haven-proxy] launch-at-login is only implemented on Windows so far.");
    console.error("  macOS: create a LaunchAgent; Linux: add a ~/.config/autostart entry — see README.");
    return 1;
  }

  const launcher = windowsLauncherPath();
  if (!action) {
    console.log(`[haven-proxy] startup:  ${existsSync(launcher) ? "on" : "off"} (${launcher})`);
    return 0;
  }
  if (action === "on") {
    mkdirSync(windowsStartupDir(), { recursive: true });
    writeFileSync(launcher, await windowsLauncherScript());
    console.log(`[haven-proxy] launch at login enabled: ${launcher}`);
    return 0;
  }
  const existed = existsSync(launcher);
  rmSync(launcher, { force: true });
  console.log(existed ? `[haven-proxy] launch at login disabled (removed ${launcher})` : "[haven-proxy] launch at login was not enabled");
  return 0;
}

function printLogTail(log, lines = 15) {
  try {
    const tail = readFileSync(log, "utf8").trimEnd().split(/\r?\n/).slice(-lines);
    if (tail.length) {
      console.error("--- last log lines ---");
      for (const line of tail) console.error(line);
    }
  } catch {}
}
