// Sandboxed preloads must be CommonJS — keep this file .cjs even though the
// rest of the app is ESM.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("haven", {
  saveKey: (key) => ipcRenderer.invoke("haven:save-key", key),
  closeWindow: () => ipcRenderer.invoke("haven:close-key-window"),
});
