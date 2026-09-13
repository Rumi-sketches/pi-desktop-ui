const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopWindow", Object.freeze({
  setTitleBarTheme(palette) {
    ipcRenderer.send("window:title-bar-theme", {
      background: palette?.background,
      foreground: palette?.foreground,
    });
  },
}));
