// Haven Proxy tray app: runs the localhost proxy (src/server.js via the
// haven-proxy package) in-process in Electron's main process. No windows by
// default — a tray icon with a menu, plus a small first-run window to paste
// the API key. Packaged builds are GUI-subsystem, so nothing ever opens a
// console.
//
// Deliberate differences from the CLI daemon:
//   - does NOT write ~/.haven-proxy/proxy.json (else `haven-proxy stop` would
//     kill this whole app via its pid) — CLI `status` therefore reports "not
//     running" while this app serves the port; the app detects the reverse
//     case (CLI daemon already on the port) and shows "running (external)".
import { app, Tray, Menu, BrowserWindow, ipcMain, shell, dialog, Notification } from "electron";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createProxyServer, DEFAULT_PORT } from "haven-proxy/server";
import {
  loadConfig,
  saveConfig,
  configPath,
  saveOpencodeProvider,
  removeOpencodeProvider,
  ensureOpencodeProvider,
  opencodeProviderStatus,
  opencodeShadowingConfigs,
  pruneLegacyOpencodeConfig,
  DEFAULT_BASE_URL,
} from "haven-proxy/config";
import { validateKey, fetchPricing } from "haven-proxy/relay";
import { logPath, windowsLauncherPath } from "haven-proxy/daemon";
import { trayIcon } from "./tray-icon.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024; // same rotation policy as the CLI daemon

let tray = null;
let proxy = null; // handle from createProxyServer while running
let state = "stopped"; // "running" | "stopped" | "external" | "error"
let lastError = "";
let keyWindow = null;
let logStream = null;
let logSink = null; // { info, warn, error } writers over logStream
let balance = { text: "Balance: …", at: 0, pending: false };
let opencodeWarning = ""; // shown in the tray menu when registration didn't take
// Strong refs until close/failed — a GC'd Notification closes its Windows toast.
const liveNotifications = new Set();

// Windows toast notifications are attributed by AppUserModelID — without this
// matching the installer's shortcut (electron-builder appId), Windows either
// drops the toast or shows it only briefly. Must be set before whenReady().
if (process.platform === "win32") app.setAppUserModelId("com.jan3.haven-proxy");

if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  if (keyWindow) {
    keyWindow.focus();
  } else {
    // No window to focus and the tray icon can be tucked into the overflow
    // area — without this, relaunching looks like it did nothing at all.
    notify(
      "Haven Proxy is already running",
      "Check your system tray icon to see status, balance, or settings.",
    );
  }
});
// Tray app: keep running with no windows.
app.on("window-all-closed", () => {});

// --- notifications -----------------------------------------------------------

// All toasts go through here: logs the lifecycle (show/close/failed) so a toast
// Windows dismisses early leaves a trace in the log file instead of just
// flashing by. Only meaningful events toast (first-run, double-launch, errors).
function notify(title, body) {
  if (!Notification.isSupported()) return;
  const log = ensureLog();
  const n = new Notification({ title, body });
  liveNotifications.add(n);
  n.on("show", () => log.info(`notification shown: ${title}`));
  n.on("close", () => {
    log.info(`notification closed: ${title}`);
    liveNotifications.delete(n);
  });
  n.on("failed", (_event, error) => {
    log.warn(`notification failed: ${title} — ${error}`);
    liveNotifications.delete(n);
  });
  n.show();
}

function notifyRunning() {
  notify(
    "Haven Proxy is running",
    "It stays in the background — click the tray icon anytime to check status, balance, or settings.",
  );
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.hide();
  tray = new Tray(trayIcon(false));
  tray.setToolTip("Haven Proxy");
  // No setContextMenu — build the menu on every open so status is current.
  tray.on("click", showMenu);
  tray.on("right-click", showMenu);

  consumeInstallOptions();
  const { cfg } = loadConfig();
  if (cfg.apiKey) {
    syncOpencode();
    await startProxy();
  } else {
    openKeyWindow();
  }
  // A long-running tray should pick up backend price changes without a restart;
  // ensureOpencodeProvider only writes when something actually changed.
  setInterval(() => syncOpencode(), 24 * 60 * 60 * 1000).unref();
});

// The Windows installer writes an option seed on fresh installs (see
// build/installer.nsh). Honor it once — only for keys the config doesn't
// already have — then delete it. Never present on macOS/Linux.
function consumeInstallOptions() {
  const seedPath = join(dirname(configPath()), "install-options.json");
  let seed;
  try {
    seed = JSON.parse(readFileSync(seedPath, "utf8"));
  } catch {
    return; // missing or malformed — nothing to consume
  }
  try {
    const { cfg } = loadConfig();
    if (typeof seed.registerOpencode === "boolean" && !("registerOpencode" in cfg)) {
      saveConfig({ ...cfg, registerOpencode: seed.registerOpencode });
    }
  } finally {
    rmSync(seedPath, { force: true });
  }
}

// --- OpenCode registration --------------------------------------------------

// Best-effort price fetch for the OpenCode registrations. `undefined` on
// failure keeps previously written (or default) prices — see resolveCosts in
// the package's config.js.
async function fetchCosts(baseURL) {
  const root = `${(baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "")}/api/v1/haven`;
  const pricing = await fetchPricing(root);
  return pricing.ok ? pricing.costs : undefined;
}

// Re-assert the provider entries on every start: an install from before the
// config-path fix, or an OpenCode config the user wiped, would otherwise stay
// broken forever with nothing to hint at why Haven models never show up.
async function syncOpencode() {
  opencodeWarning = "";
  const { cfg } = loadConfig();
  if (!cfg.apiKey) return; // keyless entries would list models that fail on first use
  if (cfg.registerOpencode === false) return; // user opted out — the toggle already removed the entries
  const log = ensureLog();
  const costs = await fetchCosts(cfg.baseURL);
  try {
    const { path, changed } = ensureOpencodeProvider(cfg.baseURL, { costs });
    if (changed) log.info(`registered Haven providers in ${path}`);
    // cwd is wherever Electron was launched, so only check the global-dir override.
    const [shadow] = opencodeShadowingConfigs(path, { cwd: null });
    if (shadow) opencodeWarning = `OpenCode config overridden by ${shadow}`;
    const legacy = pruneLegacyOpencodeConfig();
    if (legacy.pruned) log.info(`cleaned up obsolete ${legacy.path}`);
  } catch (err) {
    opencodeWarning = `OpenCode config: ${err.message}`;
    log.warn(`could not update the OpenCode config: ${err.message}`);
  }
}

async function toggleOpencode(enabled) {
  const { cfg } = loadConfig();
  const costs = enabled ? await fetchCosts(cfg.baseURL) : undefined;
  try {
    if (enabled) saveOpencodeProvider(cfg.baseURL, { costs });
    else removeOpencodeProvider();
    // Persist only after the write succeeded, so flag and on-disk state converge.
    saveConfig({ ...cfg, registerOpencode: enabled });
    opencodeWarning = "";
  } catch (err) {
    dialog.showMessageBox({
      type: "error",
      message: enabled
        ? "Could not register the Haven providers with OpenCode."
        : "Could not remove the Haven providers from the OpenCode config.",
      detail: err.message,
    });
  }
}

function showMenu() {
  refreshBalance();
  if (state === "external" || state === "error") {
    // Re-probe so the app self-heals into startable once the CLI instance stops.
    probeExternal().then(() => tray.popUpContextMenu(buildMenu()));
  } else {
    tray.popUpContextMenu(buildMenu());
  }
}

function statusLine() {
  switch (state) {
    case "running":  return `Running — 127.0.0.1:${DEFAULT_PORT}`;
    case "external": return `Running — CLI instance on port ${DEFAULT_PORT}`;
    case "error":    return `Error — ${lastError}`;
    default:         return "Stopped";
  }
}

function buildMenu() {
  const { cfg } = loadConfig();
  return Menu.buildFromTemplate([
    { label: statusLine(), enabled: false },
    ...(cfg.apiKey ? [{ label: `Key: …${cfg.apiKey.slice(-6)}`, enabled: false }] : []),
    { label: cfg.apiKey ? balance.text : "No API key — enter one below", enabled: false },
    { type: "separator" },
    {
      label: state === "running" ? "Stop proxy" : "Start proxy",
      enabled: state !== "external" && Boolean(cfg.apiKey),
      click: () => (state === "running" ? stopProxy() : startProxy()),
    },
    {
      label: "Launch at login",
      type: "checkbox",
      checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
      enabled: app.isPackaged, // dev would register electron.exe
      click: (item) => setLaunchAtLogin(item.checked),
    },
    {
      label: "Register with OpenCode",
      type: "checkbox",
      checked: opencodeProviderStatus(cfg.baseURL).registered,
      enabled: Boolean(cfg.apiKey),
      click: (item) => toggleOpencode(item.checked),
    },
    { label: "OpenCode works without the proxy running", enabled: false },
    ...(opencodeWarning ? [{ label: opencodeWarning, enabled: false }] : []),
    { type: "separator" },
    { label: "Open logs", click: () => shell.openPath(logPath()) },
    { label: "Settings…", click: openKeyWindow },
    { label: "Quit", click: quit },
  ]);
}

// --- proxy lifecycle -------------------------------------------------------

function openLogSink() {
  const file = logPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + ".old");
  } catch {} // no log yet
  logStream?.end();
  logStream = createWriteStream(file, { flags: "a" });
  const write = (level) => (msg) =>
    logStream.write(`${new Date().toISOString()} ${level} ${msg}\n`);
  logSink = { info: write("INFO"), warn: write("WARN"), error: write("ERROR") };
  return logSink;
}

// A toast can fire before the proxy ever starts (e.g. second-instance ping) —
// open the sink on demand so those events still get logged.
function ensureLog() {
  return logSink ?? openLogSink();
}

async function startProxy() {
  if (proxy) return;
  const { cfg } = loadConfig(); // fresh read — the CLI may have changed it
  if (!cfg.apiKey) {
    openKeyWindow();
    return;
  }
  try {
    const candidate = createProxyServer({
      apiKey: cfg.apiKey,
      baseURL: (cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
      log: openLogSink(),
    });
    await candidate.listen({ port: DEFAULT_PORT });
    proxy = candidate;
    state = "running";
    refreshBalance(true);
  } catch (err) {
    if (err?.code === "EADDRINUSE") await probeExternal();
    else {
      state = "error";
      lastError = err?.message || String(err);
    }
  }
  updateTrayIcon();
}

async function stopProxy() {
  if (!proxy) return;
  const closing = proxy;
  proxy = null;
  state = "stopped";
  updateTrayIcon();
  // server.close() waits for in-flight relays, which can be minutes — cap it.
  await Promise.race([closing.close(), new Promise((r) => setTimeout(r, 2000))]);
  closing.server.closeAllConnections();
}

async function probeExternal() {
  if (proxy) return; // we own the port after all
  try {
    const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      state = "external";
      updateTrayIcon();
      return;
    }
  } catch {}
  if (state === "external") state = "stopped"; // CLI instance went away
  if (state !== "error") updateTrayIcon();
}

function updateTrayIcon() {
  tray?.setImage(trayIcon(state === "running" || state === "external"));
}

async function quit() {
  await stopProxy();
  logStream?.end();
  tray?.destroy();
  app.quit();
}

// --- balance (lazy, cached; menus can't mutate while open, so the value shown
// is at most one open stale) -------------------------------------------------

function refreshBalance(force = false) {
  if (balance.pending) return;
  if (!force && Date.now() - balance.at < 60_000) return;
  const { cfg } = loadConfig();
  if (!cfg.apiKey) return;
  balance.pending = true;
  const root = `${(cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "")}/api/v1/haven`;
  validateKey(root, cfg.apiKey)
    .then((result) => {
      if (result.ok) balance.text = `Balance: $${result.balance.toFixed(2)}`;
      else if (result.reason === "invalid_key") balance.text = "Balance: key is INVALID";
      else if (result.reason === "empty_balance") balance.text = "Balance: $0.00 — top up";
      else balance.text = "Balance: unreachable";
      balance.at = Date.now();
    })
    .catch(() => {})
    .finally(() => {
      balance.pending = false;
    });
}

// --- launch at login --------------------------------------------------------

function setLaunchAtLogin(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled });
  // The CLI's `startup on` registers its own launcher; both together would
  // race for the port at login (loser just shows "external", but warn anyway).
  if (enabled && process.platform === "win32" && existsSync(windowsLauncherPath())) {
    dialog.showMessageBox({
      type: "warning",
      message: "The haven-proxy CLI is also set to start at login.",
      detail:
        `Both this app and the CLI launcher (${windowsLauncherPath()}) will try to start ` +
        `a proxy on port ${DEFAULT_PORT} at login. Run \`haven-proxy startup off\` to keep just the app.`,
    });
  }
}

// --- settings window (first-run key entry + later edits) -------------------

function openKeyWindow() {
  if (keyWindow) {
    keyWindow.focus();
    return;
  }
  keyWindow = new BrowserWindow({
    width: 440,
    height: 340,
    resizable: false,
    autoHideMenuBar: true,
    title: "Haven Proxy — Settings",
    webPreferences: { preload: join(import.meta.dirname, "preload.cjs") },
  });
  keyWindow.loadFile("key-window.html");
  keyWindow.on("closed", () => {
    keyWindow = null;
  });
}

ipcMain.handle("haven:get-settings", () => {
  const { cfg } = loadConfig();
  return { baseURL: cfg.baseURL || DEFAULT_BASE_URL, defaultBaseURL: DEFAULT_BASE_URL };
});

// Both settings flows do the same thing once the new values validate: persist them
// (even when Haven was unreachable, like the CLI's login), re-register with
// OpenCode best-effort, and restart the relay so it picks the change up.
async function applySettings(cfg, { apiKey, baseURL }, result, { notifyIfStarted = false } = {}) {
  saveConfig({ ...cfg, apiKey, baseURL });
  let warning =
    result.reason === "unreachable" ? "Could not reach Haven to verify — saved anyway." : null;
  try {
    // The backend may have changed, so fetch that backend's prices.
    if (cfg.registerOpencode !== false) {
      ensureOpencodeProvider(baseURL, { costs: await fetchCosts(baseURL) });
    }
  } catch (err) {
    warning = `Saved, but could not update the OpenCode config: ${err.message}`;
  }
  if (state !== "external") {
    await stopProxy(); // key or backend changed: restart the relay with the new values
    await startProxy();
  }
  if (notifyIfStarted && (state === "running" || state === "external")) notifyRunning();
  refreshBalance(true);
  return {
    ok: true,
    warning,
    balance: result.ok ? result.balance : null,
    emptyBalance: result.reason === "empty_balance",
  };
}

ipcMain.handle("haven:save-key", async (_event, { apiKey: rawKey } = {}) => {
  const apiKey = String(rawKey || "").trim();
  if (!apiKey) return { ok: false, error: "API key is required." };
  const { cfg } = loadConfig();
  const isFirstSetup = !cfg.apiKey;
  const baseURL = (cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const result = await validateKey(`${baseURL}/api/v1/haven`, apiKey);
  if (result.reason === "invalid_key") {
    return { ok: false, error: "Key is invalid — check it and try again." };
  }
  return applySettings(cfg, { apiKey, baseURL }, result, { notifyIfStarted: isFirstSetup });
});

ipcMain.handle("haven:save-base-url", async (_event, { baseURL: rawBaseURL } = {}) => {
  const baseURL = String(rawBaseURL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const { cfg } = loadConfig();
  if (!cfg.apiKey) {
    // Nothing to validate against yet — just persist it for when a key is entered.
    // Deliberately no OpenCode entry either: without a key its models would fail.
    saveConfig({ ...cfg, baseURL });
    return {
      ok: true,
      warning: "Backend URL saved. Enter an API key above to start the proxy.",
      balance: null,
      emptyBalance: false,
    };
  }
  const result = await validateKey(`${baseURL}/api/v1/haven`, cfg.apiKey);
  if (result.reason === "invalid_key") {
    return { ok: false, error: "The saved API key is invalid against this backend." };
  }
  return applySettings(cfg, { apiKey: cfg.apiKey, baseURL }, result);
});

ipcMain.handle("haven:close-key-window", () => {
  keyWindow?.close();
});
