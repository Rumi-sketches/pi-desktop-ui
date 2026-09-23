const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopWindow", Object.freeze({
  isWindows: process.platform === "win32",
  notifyChatFinished(key, title) {
    ipcRenderer.send("chat:finished", { key, title });
  },
  onChatNotificationClick(callback) {
    ipcRenderer.on("chat:notification-click", (_event, key) => callback(key));
  },
  setTitleBarTheme(palette) {
    ipcRenderer.send("window:title-bar-theme", {
      background: palette?.background,
      foreground: palette?.foreground,
    });
  },
}));
