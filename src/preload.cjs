"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("archiveAPI", {
  subscribeSelection: (callback) => {
    const listener = (_event, id) => callback(id);
    ipcRenderer.on("archive:select", listener);
    return () => ipcRenderer.removeListener("archive:select", listener);
  },
  call: async (action, payload) => {
    const result = await ipcRenderer.invoke("archive:action", action, payload);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("archive:changed", listener);
    return () => ipcRenderer.removeListener("archive:changed", listener);
  },
  subscribeErrors: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("archive:error", listener);
    return () => ipcRenderer.removeListener("archive:error", listener);
  },
});
