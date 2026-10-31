// The renderer's only way to the host: one request channel and one event channel, both fixed. No ipcRenderer, no
// Node, no path reaches the page; main checks every request (parseDesktopRequest) and who sent it.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const INVOKE_CHANNEL = "agentduo:invoke";
const EVENT_CHANNEL = "agentduo:event";

contextBridge.exposeInMainWorld("agentduo", {
  invoke: (request: unknown) => ipcRenderer.invoke(INVOKE_CHANNEL, request),
  onEvent: (listener: (event: unknown) => void) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const wrapped = (_e: IpcRendererEvent, event: unknown) => listener(event);
    ipcRenderer.on(EVENT_CHANNEL, wrapped);
    return () => void ipcRenderer.removeListener(EVENT_CHANNEL, wrapped);
  },
});
