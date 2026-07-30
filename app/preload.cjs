// Sandboxed preloads must be CommonJS — keep this file .cjs even though the
// rest of the app is ESM.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("haven", {
  getSettings: () => ipcRenderer.invoke("haven:get-settings"),
  saveKey: (payload) => ipcRenderer.invoke("haven:save-key", payload),
  saveBaseURL: (payload) => ipcRenderer.invoke("haven:save-base-url", payload),
  closeWindow: () => ipcRenderer.invoke("haven:close-key-window"),
});
