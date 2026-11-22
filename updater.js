// Auto-update via GitHub Releases (electron-updater) avec popup de confirmation
const { app, ipcMain } = require('electron');
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { /* dev sans dépendance */ }

module.exports = function initUpdater({ send, isPlaying }) {
  let ready = false, downloading = false, notified = '';
  ipcMain.handle('upd:download', () => {
    if (!autoUpdater) return false;
    downloading = true;
    autoUpdater.downloadUpdate().catch(() => {});
    return true;
  });
  ipcMain.handle('upd:install', () => {
    if (!autoUpdater || !ready || isPlaying()) return false; // jamais pendant que Minecraft tourne
    autoUpdater.quitAndInstall(true, true); // silencieux + relance
    return true;
  });
  if (!autoUpdater || !app.isPackaged) return; // seulement dans la version installée
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => {
    if (i.version !== notified) { notified = i.version; send('upd', { state: 'available', version: i.version }); }
  });
  autoUpdater.on('download-progress', (p) => send('upd', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => { ready = true; downloading = false; send('upd', { state: 'ready', version: i.version }); });
  autoUpdater.on('error', (e) => {
    console.log('[update]', e && e.message);
    if (downloading) { downloading = false; send('upd', { state: 'error' }); }
  });
  const check = () => { if (!ready && !downloading) autoUpdater.checkForUpdates().catch(() => {}); };
  check();
  setInterval(check, 30 * 60 * 1000);
};
