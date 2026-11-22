// Auto-update via GitHub Releases (electron-updater)
const { app } = require('electron');
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { /* dev sans dépendance */ }

module.exports = function initUpdater({ send, isPlaying }) {
  if (!autoUpdater || !app.isPackaged) return; // seulement dans la version installée
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let ready = false;
  const tryInstall = () => { if (ready && !isPlaying()) autoUpdater.quitAndInstall(true, true); }; // silencieux + relance
  autoUpdater.on('update-available', (i) => send('upd', { state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => send('upd', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => { ready = true; send('upd', { state: 'ready', version: i.version }); tryInstall(); });
  autoUpdater.on('error', (e) => console.log('[update]', e && e.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(() => { check(); tryInstall(); }, 30 * 60 * 1000);
};
