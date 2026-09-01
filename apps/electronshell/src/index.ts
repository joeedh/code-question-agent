import { app, BrowserWindow } from "electron";
import { join } from "node:path";

const CDP_PORT = process.env.CDP_PORT ?? "9333";
const START_URL = process.env.SHELL_URL ?? "about:blank";
const APP_NAME = "code-question-agent-shell";

// Must run before `app` emits "ready" — Chromium reads debugging switches at startup.
app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT);
app.commandLine.appendSwitch("remote-debugging-address", "0.0.0.0");

// Chromium derives userData from the app name, so an unnamed shell shares cookies,
// local storage and cache with every other default-named Electron app on the box.
app.setName(APP_NAME);
const profileDir = process.env.SHELL_PROFILE_DIR ?? join(app.getPath("appData"), APP_NAME);
app.setPath("userData", profileDir);
app.setPath("sessionData", profileDir);

function createWindow(): void {
  const win = new BrowserWindow({ width: 1024, height: 768 });
  void win.loadURL(START_URL);
}

// A second shell on this profile would fail to bind `CDP_PORT` and leave a window
// the cdp tool can never reach.
if (app.requestSingleInstanceLock()) {
  app.whenReady().then(createWindow);

  app.on("window-all-closed", () => {
    app.quit();
  });
} else {
  app.quit();
}
