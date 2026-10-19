const { app, ipcMain } = require('electron');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
if (!process.env.FORGEDESK_DATA_DIR || !process.env.FORGEDESK_OFFLINE_SERVER) throw new Error('Offline fixture bootstrap is not a product entry point');
app.setPath('userData', process.env.FORGEDESK_DATA_DIR);
for (const key of ['sessionData', 'crashDumps']) {
  const directory = path.join(process.env.FORGEDESK_DATA_DIR, key); mkdirSync(directory, { recursive: true }); app.setPath(key, directory);
}
app.setAppLogsPath(path.join(process.env.FORGEDESK_DATA_DIR, 'logs'));

let armed = false;
let delayingSubscriptions = false;
let releaseSnapshots = [];
let notifyCaptured;
let captured;
let queued = [];
let initialSnapshots = 0;
let directSnapshotBypass = false;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, channel !== 'forgedesk:invoke' ? callback : async (...args) => {
  const result = await callback(...args);
  if (args[1] === 'snapshot' && armed) {
    if (directSnapshotBypass) { directSnapshotBypass = false; return result; }
    const capturedResult = structuredClone(result);
    initialSnapshots++;
    if (initialSnapshots === 2) notifyCaptured();
    await new Promise(resolve => { releaseSnapshots.push(resolve); });
    return capturedResult;
  }
  return result;
});
app.on('browser-window-created', (_event, window) => {
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => {
    if (channel === 'forgedesk:snapshot' && delayingSubscriptions) {
      const capturedArgs = structuredClone(args); queued.push(() => send(channel, ...capturedArgs));
    }
    else send(channel, ...args);
  };
});
globalThis.__controlsOfflineTiming = {
  arm() { armed = true; initialSnapshots = 0; directSnapshotBypass = false; delayingSubscriptions = true; captured = new Promise(resolve => { notifyCaptured = resolve; }); },
  captured() { return captured; },
  allowOneDirectSnapshot() {
    if (!armed || initialSnapshots !== 2 || directSnapshotBypass) throw new Error('Both StrictMode startup reads must be captured before the explicit direct API probe');
    directSnapshotBypass = true;
  },
  release() {
    armed = false; delayingSubscriptions = false;
    const responses = releaseSnapshots; releaseSnapshots = []; for (const release of responses) release();
    const pending = queued; queued = []; for (const send of pending) send();
  },
};
require('./production.cjs');
