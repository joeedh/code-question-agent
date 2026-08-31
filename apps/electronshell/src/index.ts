import { app, BrowserWindow } from "electron";

const CDP_PORT = process.env.CDP_PORT ?? "9222";
const START_URL = process.env.SHELL_URL ?? "about:blank";

// Must run before `app` emits "ready" — Chromium reads debugging switches at startup.
app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT);
app.commandLine.appendSwitch("remote-debugging-address", "0.0.0.0");

function createWindow(): void {
  const win = new BrowserWindow({ width: 1024, height: 768 });
  void win.loadURL(START_URL);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});
