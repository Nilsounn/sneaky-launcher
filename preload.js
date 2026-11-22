const { contextBridge, ipcRenderer } = require('electron');
const inv = (c) => (a) => ipcRenderer.invoke(c, a);
contextBridge.exposeInMainWorld('sneaky', {
  init: () => ipcRenderer.invoke('init'),
  play: (o) => ipcRenderer.send('play', o),
  stop: () => ipcRenderer.send('stop'),
  folder: (sub) => ipcRenderer.send('folder', sub),
  win: (a) => ipcRenderer.send('win', a),
  setTheme: (t) => ipcRenderer.send('theme', t),
  on: (ch, fn) => ipcRenderer.on(ch, (_, d) => fn(d)),
  packRefresh: () => ipcRenderer.invoke('pack:refresh'),
  setAutostart: inv('settings:autostart'),
  serverStatus: () => ipcRenderer.invoke('server:status'),
  discord: () => ipcRenderer.send('discord'),
  copyIp: () => ipcRenderer.send('copy-ip'),
  authMs: inv('auth:ms'), authOffline: inv('auth:offline'), authLogout: inv('auth:logout'), authUuid: inv('auth:uuid'),
  mrSearch: inv('mr:search'), mrList: inv('mr:list'), mrInstall: inv('mr:install'), mrRemove: inv('mr:remove')
});
