"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const id = new URL(location.href).searchParams.get("capture");
if (/^[0-9a-f-]{36}$/.test(id))
  contextBridge.exposeInMainWorld("localMicrophone", {
    send: (payload) => ipcRenderer.send(`local-mic:${id}`, payload),
    onStop: (listener) =>
      ipcRenderer.once(`local-mic-stop:${id}`, () => listener()),
    onAck: (listener) =>
      ipcRenderer.on(`local-mic-ack:${id}`, () => listener()),
  });
