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
import { app, Tray, Menu, BrowserWindow, ipcMain, shell, dialog } from "electron";
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createProxyServer, DEFAULT_PORT } from "haven-proxy/server";
import { loadConfig, saveConfig, saveOpencodeProvider, DEFAULT_BASE_URL } from "haven-proxy/config";
import { validateKey } from "haven-proxy/relay";
import { logPath, windowsLauncherPath } from "haven-proxy/daemon";
import { trayIcon } from "./tray-icon.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024; // same rotation policy as the CLI daemon

let tray = null;
let proxy = null; // handle from createProxyServer while running
let state = "stopped"; // "running" | "stopped" | "external" | "error"
let lastError = "";
let keyWindow = null;
let logStream = null;
let balance = { text: "Balance: …", at: 0, pending: false };

if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  if (keyWindow) keyWindow.focus();
});
// Tray app: keep running with no windows.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.hide();
  tray = new Tray(trayIcon(false));
  tray.setToolTip("Haven Proxy");
  // No setContextMenu — build the menu on every open so status is current.
  tray.on("click", showMenu);
  tray.on("right-click", showMenu);

  const { cfg } = loadConfig();
  if (cfg.apiKey) await startProxy();
  else openKeyWindow();
});

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
    { type: "separator" },
    { label: "Open logs", click: () => shell.openPath(logPath()) },
    { label: "Enter API key…", click: openKeyWindow },
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
  return { info: write("INFO"), warn: write("WARN"), error: write("ERROR") };
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

// --- first-run key entry ------------------------------------------------------

function openKeyWindow() {
  if (keyWindow) {
    keyWindow.focus();
    return;
  }
  keyWindow = new BrowserWindow({
    width: 440,
    height: 260,
    resizable: false,
    autoHideMenuBar: true,
    title: "Haven Proxy — API key",
    webPreferences: { preload: join(import.meta.dirname, "preload.cjs") },
  });
  keyWindow.loadFile("key-window.html");
  keyWindow.on("closed", () => {
    keyWindow = null;
  });
}

ipcMain.handle("haven:save-key", async (_event, rawKey) => {
  const apiKey = String(rawKey || "").trim();
  if (!apiKey) return { ok: false, error: "API key is required." };
  const { cfg } = loadConfig();
  const baseURL = (cfg.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const result = await validateKey(`${baseURL}/api/v1/haven`, apiKey);
  if (result.reason === "invalid_key") {
    return { ok: false, error: "Key is invalid — check it and try again." };
  }
  // Mirror the CLI login side effects: save even when Haven is unreachable,
  // and register the OpenCode provider best-effort.
  saveConfig({ ...cfg, apiKey, baseURL });
  let warning =
    result.reason === "unreachable" ? "Could not reach Haven to verify — saved anyway." : null;
  try {
    saveOpencodeProvider(apiKey, baseURL);
  } catch (err) {
    warning = `Saved, but could not update the OpenCode config: ${err.message}`;
  }
  if (state !== "external") {
    await stopProxy(); // key changed: restart the relay with the new key
    await startProxy();
  }
  refreshBalance(true);
  return {
    ok: true,
    warning,
    balance: result.ok ? result.balance : null,
    emptyBalance: result.reason === "empty_balance",
  };
});

ipcMain.handle("haven:close-key-window", () => {
  keyWindow?.close();
});
