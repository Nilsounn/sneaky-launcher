const { app, BrowserWindow, ipcMain, shell, safeStorage, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { Auth } = require('msmc');
const serverStatus = require('./serverstatus');
const { jvmArgs } = require('./loaderargs');
const packsync = require('./packsync');
const extract = require('extract-zip');
const { Client } = require('minecraft-launcher-core');

// ---- Dossiers : tout est local, à côté de l'exe ----
const ROOT = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
const DATA = path.join(ROOT, 'sneaky-data');
const GAME = path.join(DATA, 'game');
const RUNTIME = path.join(DATA, 'runtime');
const INSTALLERS = path.join(DATA, 'installers');
const CFG_FILE = path.join(DATA, 'config.json');
const SET_FILE = path.join(DATA, 'settings.json');
const INDEX_FILE = path.join(DATA, 'modrinth-index.json');
const PACK_CACHE = path.join(DATA, 'pack-cache.json');   // dernier manifeste reçu du panel admin

// >>> manifestUrl : la liste publiée par ton app « Sneaky Admin » dans Firebase, ex. 'https://mon-projet-default-rtdb.europe-west1.firebasedatabase.app/manifest.json'
// >>> storageBucket : bucket Firebase Storage de tes mods envoyés à la main (ex. 'mon-projet.firebasestorage.app') — vide si tu n'utilises que Modrinth
const MANIFEST_URL = 'https://sneakylauncher-default-rtdb.europe-west1.firebasedatabase.app/manifest.json'; // intégré en dur : plus rien à modifier à chaque build
const DEFAULT_CFG = { serverIp: '', statusIp: 'stapling-partners.tun.ply.gg', mc: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.263', manifestUrl: MANIFEST_URL, storageBucket: '' };
const DISCORD_URL = 'https://discord.gg/Eeu5x9xk4J';
const readJson = (f, d) => { try { return { ...d, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return { ...d }; } };
fs.mkdirSync(GAME, { recursive: true });
if (!fs.existsSync(CFG_FILE)) fs.writeFileSync(CFG_FILE, JSON.stringify(DEFAULT_CFG, null, 2));
// Dernier manifeste reçu du panel (mémoire + disque) : ses versions / IP / Discord prennent le dessus sur config.json
let packMem, liveIp = '';
const cachedPack = () => { if (packMem === undefined) { try { packMem = packsync.validate(JSON.parse(fs.readFileSync(PACK_CACHE, 'utf8'))); } catch { packMem = null; } } return packMem; };
const cfg = () => {
  const c = readJson(CFG_FILE, DEFAULT_CFG);
  c.manifestUrl = MANIFEST_URL;                                        // toujours l'URL intégrée : un ancien config.json ne peut plus la remplacer
  if (!c.storageBucket) c.storageBucket = DEFAULT_CFG.storageBucket;
  const m = c.manifestUrl ? cachedPack() : null;
  if (m) { c.mc = m.mc; c.loader = m.loader; c.loaderVersion = m.loaderVersion; if (m.statusIp) c.statusIp = m.statusIp; if (m.discord) c.discord = m.discord; }
  if (liveIp) c.statusIp = liveIp;                                     // IP annoncée en direct par SneakyServer (/status/ip) : prime sur le manifeste
  return c;
};
async function refreshPack() {
  const url = cfg().manifestUrl;
  if (!url) return { ok: false, none: true };
  try { const m = await packsync.fetchManifest(url); fs.writeFileSync(PACK_CACHE, JSON.stringify(m)); packMem = m; return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
const packInfo = () => {
  const c = cfg(), m = c.manifestUrl ? cachedPack() : null;
  return { enabled: !!c.manifestUrl, synced: !!m, news: m ? m.news : null, mods: m ? m.mods.length + m.resourcepacks.length : 0, version: `${c.mc} · ${LN[c.loader] || c.loader} ${c.loaderVersion}`, statusIp: c.statusIp };
};
// Fichiers imposés par le serveur (dernier manifeste + dernière synchro) : verrouillés côté joueur
function managedMeta(type) {
  const out = new Map(), m = cfg().manifestUrl ? cachedPack() : null;
  if (m) for (const e of m[packsync.TYPES[type].key]) out.set(e.file, e);
  try { for (const f of JSON.parse(fs.readFileSync(path.join(DATA, 'managed.json'), 'utf8'))[type] || []) if (!out.has(f)) out.set(f, null); } catch {}
  return out;
}
const settings = () => {
  const s = readJson(SET_FILE, { ram: 4 });
  if (!s.account && s.username) s.account = { type: 'offline', name: s.username, uuid: offlineUUID(s.username) }; // ancien format
  return s;
};
const autostart = () => settings().autostart !== false; // activé par défaut, comme avant
const saveSettings = (patch) => { const { username, ...cur } = settings(); fs.writeFileSync(SET_FILE, JSON.stringify({ ...cur, ...patch }, null, 2)); };

// ---- Comptes ----
// UUID hors-ligne : même algorithme que Minecraft (UUID v3 de "OfflinePlayer:<pseudo>")
function offlineUUID(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const dash = (u) => (u.includes('-') ? u : `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`);
const pub = (a) => (a ? { type: a.type, name: a.name, uuid: a.uuid } : null);
// Le refresh token Microsoft n'est stocké que chiffré (DPAPI sous Windows)
const enc = (t) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(t).toString('base64') : null);
const dec = (t) => { try { return safeStorage.decryptString(Buffer.from(t, 'base64')); } catch { return null; } };
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { const m = e && e.message ? e.message : String(e); return { error: m === 'error.gui.closed' ? 'Fenêtre de connexion fermée.' : m }; } };

async function getAuth(acc) {
  if (acc.type === 'microsoft') {
    const tok = acc.refresh && dec(acc.refresh);
    if (!tok) throw new Error('Session Microsoft expirée : reconnecte-toi.');
    const xbox = await new Auth('select_account').refresh(tok);
    const mc = await xbox.getMinecraft();
    if (!mc.profile) throw new Error('Ce compte ne possède pas Minecraft Java Edition.');
    const r = enc(xbox.save());
    saveSettings({ account: { type: 'microsoft', name: mc.profile.name, uuid: dash(mc.profile.id), ...(r ? { refresh: r } : {}) } });
    return mc.mclc();
  }
  const uuid = acc.uuid || offlineUUID(acc.name);
  return { access_token: uuid, client_token: uuid, uuid, name: acc.name, user_properties: '{}', meta: { type: 'mojang', demo: false } };
}
const LN = { neoforge: 'NeoForge', forge: 'Forge', fabric: 'Fabric' };
const versionId = () => { const c = cfg(); return c.loader === 'forge' ? `${c.mc}-forge-${c.loaderVersion}` : c.loader === 'fabric' ? `fabric-loader-${c.loaderVersion}-${c.mc}` : `neoforge-${c.loaderVersion}`; };
const javaMajor = () => { const [, m, p] = cfg().mc.split('.').map(Number); return m >= 21 || (m === 20 && (p || 0) >= 5) ? 21 : 17; };
const isInstalled = () => fs.existsSync(path.join(GAME, 'versions', versionId(), versionId() + '.json'));

// ---- Fenêtre unique ----
if (!app.requestSingleInstanceLock()) app.quit();
let win, tray, proc = null, busy = false, quitting = false, userStopped = false;
const showWin = () => { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); };
app.on('second-instance', showWin);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { if (tray) tray.destroy(); });

const send = (ch, d) => win && !win.isDestroyed() && win.webContents.send(ch, d);
// Logs : on masque les lignes parasites (chemins de classes / ressources) et on envoie par paquets,
// sinon l'interface est submergée et les boutons ne répondent plus.
const SPAM = /^[\w$.\-]+(\/[\w$.\-]+)+\.\w{2,6}$/;
let logBuf = '', logTimer = null, spamNoted = false;
function pushLog(text) {
  const keep = [];
  for (const l of String(text).split(/\r?\n/)) {
    if (!l) continue;
    if (SPAM.test(l.trim())) { if (!spamNoted) { spamNoted = true; keep.push('[Sneaky] Lignes de debug (chemins .class, etc.) masquées.'); } continue; }
    keep.push(l);
  }
  if (!keep.length) return;
  logBuf += keep.join('\n') + '\n';
  if (logBuf.length > 100000) logBuf = logBuf.slice(-100000);
  if (!logTimer) logTimer = setTimeout(() => { logTimer = null; const b = logBuf; logBuf = ''; send('log', b); }, 100);
}
const slog = (t) => pushLog('[Sneaky] ' + t);
let lastProg = 0;
const sendProg = (p) => { const now = Date.now(); if (p.ratio < 1 && now - lastProg < 100) return; lastProg = now; send('prog', p); };

// ---- Zone de notification (les petites icônes à côté de la flèche ^) ----
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir Sneaky', click: showWin },
    { label: 'Arrêter Minecraft', enabled: !!proc, click: () => { if (proc) { userStopped = true; proc.kill(); } } },
    { type: 'separator' },
    { label: proc ? 'Quitter (ferme aussi Minecraft)' : 'Quitter', click: () => { quitting = true; if (proc) proc.kill(); app.quit(); } }
  ]));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'sneaky-logo.png')).resize({ width: 32, height: 32 }));
  tray.setToolTip('Sneaky');
  tray.on('click', showWin);
  updateTray();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 700, minWidth: 980, minHeight: 640, frame: false,
    backgroundColor: '#0b0713', icon: path.join(__dirname, 'assets', 'sneaky-logo.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.setMenu(null);
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } }); // la croix met en arrière-plan
  win.on('session-end', () => { quitting = true; });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}
app.whenReady().then(() => {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: autostart() }); // lancement au démarrage de Windows (réglable)
  createWindow();
  createTray();
  require('./updater')({ send: (c, d) => win && !win.isDestroyed() && win.webContents.send(c, d), isPlaying: () => !!proc });
});
app.on('window-all-closed', () => { if (proc) proc.kill(); app.quit(); });

// ---- Téléchargement avec suivi de progression ----
function download(url, dest, label) {
  return new Promise((resolve, reject) => {
    const go = (u) => https.get(u, { headers: { 'User-Agent': 'SneakyLauncher' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode)) { r.resume(); return go(new URL(r.headers.location, u).href); }
      if (r.statusCode !== 200) return reject(new Error(`HTTP ${r.statusCode} pour ${u}`));
      const total = +r.headers['content-length'] || 0; let n = 0;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const f = fs.createWriteStream(dest);
      r.on('data', (c) => { n += c.length; if (total) sendProg({ label, ratio: n / total }); });
      r.pipe(f);
      f.on('finish', () => f.close(resolve));
      f.on('error', reject);
    }).on('error', reject);
    go(url);
  });
}

// ---- Java 21 local ----
function findJava(n = 21) {
  const base = n === 21 ? RUNTIME : path.join(RUNTIME, 'j' + n);
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    const p = path.join(base, d, 'bin', 'javaw.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
async function ensureJava(n = 21) {
  let j = findJava(n);
  if (j) return j;
  slog(`Téléchargement de Java ${n} (une seule fois)…`);
  const zip = path.join(DATA, 'tmp', `jre${n}.zip`);
  await download(`https://api.adoptium.net/v3/binary/latest/${n}/ga/windows/x64/jre/hotspot/normal/eclipse`, zip, 'Java ' + n);
  await extract(zip, { dir: n === 21 ? RUNTIME : path.join(RUNTIME, 'j' + n) });
  fs.rmSync(path.dirname(zip), { recursive: true, force: true });
  j = findJava(n);
  if (!j) throw new Error(`Java ${n} introuvable après extraction`);
  return j;
}

// ---- Loader local (NeoForge / Forge / Fabric) ----
async function ensureLoader(javaw) {
  if (isInstalled()) return;
  const { loader, mc, loaderVersion: v } = cfg(), java = javaw.replace('javaw.exe', 'java.exe');
  let name, url, args;
  if (loader === 'fabric') {
    const iv = (await (await fetch('https://meta.fabricmc.net/v2/versions/installer')).json())[0].version;
    name = `fabric-installer-${iv}.jar`; url = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${iv}/${name}`;
    args = (jar) => ['-jar', jar, 'client', '-dir', GAME, '-mcversion', mc, '-loader', v, '-noprofile'];
  } else if (loader === 'forge') {
    name = `forge-${mc}-${v}-installer.jar`; url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${v}/${name}`;
    args = (jar) => ['-jar', jar, '--installClient', GAME];
  } else {
    name = `neoforge-${v}-installer.jar`; url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/${name}`;
    args = (jar) => ['-jar', jar, '--installClient', GAME];
  }
  let jar = path.join(INSTALLERS, name);
  const shipped = path.join(process.resourcesPath || '', 'installers', name);
  if (!fs.existsSync(jar) && fs.existsSync(shipped)) jar = shipped;
  if (!fs.existsSync(jar)) { slog(`Téléchargement de ${LN[loader]} ${v}…`); jar = path.join(INSTALLERS, name); await download(url, jar, LN[loader]); }
  slog(`Installation de ${LN[loader]} (1 à 3 minutes)…`);
  const lp = path.join(GAME, 'launcher_profiles.json');
  if (!fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ profiles: {} }));
  await new Promise((res, rej) => {
    const p = spawn(java, args(jar), { cwd: GAME, windowsHide: true });
    p.stdout.on('data', (d) => pushLog(d.toString()));
    p.stderr.on('data', (d) => pushLog(d.toString()));
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('Installateur ' + LN[loader] + ' : code ' + c))));
  });
  if (!isInstalled()) throw new Error(LN[loader] + ' non installé, voir la console');
}

// ---- Lancement ----
async function play({ ram }) {
  if (busy || proc) return;
  busy = true; userStopped = false; send('state', 'busy');
  try {
    const acc = settings().account;
    if (!acc) throw new Error('Aucun compte : connecte-toi (Microsoft ou hors-ligne).');
    ram = Math.min(12, Math.max(2, +ram || 4));
    saveSettings({ ram });
    const bundle = path.join(process.resourcesPath || '', 'bundle');
    const devBundle = path.join(__dirname, 'bundle');
    const src = fs.existsSync(bundle) ? bundle : devBundle;
    if (fs.existsSync(src)) fs.cpSync(src, GAME, { recursive: true, force: true });

    // Panel admin : versions + mods obligatoires
    let pack = null;
    if (cfg().manifestUrl) {
      const r = await refreshPack(); pack = cachedPack();
      if (r.ok) send('pack', packInfo());
      else if (!pack) throw new Error('Liste des mods du serveur injoignable : ' + r.error);
      else slog(`Serveur de mods injoignable (${r.error}) : dernière liste connue utilisée.`);
    }
    const javaw = await ensureJava(javaMajor());
    await ensureLoader(javaw);
    if (pack) {
      const keep = { mod: bundleNames('mod'), resourcepack: bundleNames('resourcepack') };
      slog('Vérification des mods du serveur…');
      const st = await packsync.syncFiles(pack, cfg().manifestUrl, { gameDir: GAME, dataDir: DATA, keep, storageBucket: cfg().storageBucket, onProgress: sendProg, log: slog });
      slog(`Mods du serveur : ${st.ok} à jour, ${st.downloaded} téléchargé(s), ${st.removed} retiré(s)` + (st.moved ? `, ${st.moved} mis de côté` : '') + '.');
    }

    const c = cfg();
    const launcher = new Client();
    launcher.on('data', (d) => pushLog(String(d)));
    launcher.on('progress', (p) => sendProg({ label: p.type, ratio: p.total ? p.task / p.total : 0 }));
    launcher.on('close', (code) => {
      proc = null; busy = false; send('prog', null); slog(`Minecraft fermé (code ${code}).`); send('state', 'idle'); updateTray();
      if (code !== 0 && !userStopped) showWin(); // plantage : on réaffiche le launcher pour lire la console
    });

    slog('Lancement de Minecraft…');
    const loaderArgs = jvmArgs(path.join(GAME, 'versions', versionId(), versionId() + '.json'), {
      library_directory: path.resolve(GAME, 'libraries'), classpath_separator: path.delimiter,
      version_name: versionId(), launcher_name: 'Sneaky', launcher_version: '1.0', game_directory: GAME
    });
    if (!loaderArgs.length && c.loader !== 'fabric') throw new Error(`Arguments JVM de ${LN[c.loader]} introuvables : supprime sneaky-data/game/versions et relance pour réinstaller le loader.`);
    slog(`Arguments JVM ${LN[c.loader]} chargés (${loaderArgs.length}).`);
    const opts = {
      customArgs: loaderArgs,
      authorization: await getAuth(acc),
      root: GAME, javaPath: javaw,
      version: { number: c.mc, type: 'release', custom: versionId() },
      memory: { max: `${ram}G`, min: '1G' },
      overrides: { detached: false },
      window: { title: 'Sneaky SMP' }
    };
    if (c.serverIp) opts.customLaunchArgs = ['--quickPlayMultiplayer', c.serverIp];
    proc = await launcher.launch(opts);
    if (!proc) throw new Error('Le jeu n’a pas pu démarrer.');
    send('prog', null); send('state', 'playing'); updateTray();
    if (win && !win.isDestroyed()) win.hide(); // le launcher passe en arrière-plan pendant le jeu
  } catch (e) {
    proc = null; busy = false; send('prog', null);
    pushLog('[Sneaky] ERROR ' + e.message); send('state', 'idle'); updateTray();
  }
}

ipcMain.handle('init', () => { const st = settings(); return { account: pub(st.account), ram: st.ram || 4, installed: isInstalled(), autostart: autostart(), pack: packInfo(), serverIp: cfg().serverIp, statusIp: cfg().statusIp, version: `${cfg().mc} · ${LN[cfg().loader] || cfg().loader} ${cfg().loaderVersion}` }; });
ipcMain.on('play', (_, o) => play(o));
ipcMain.on('stop', () => { if (proc) { userStopped = true; proc.kill(); } });
ipcMain.on('folder', (_, sub) => { const d = sub === 'mod' ? 'mods' : sub === 'resourcepack' ? 'resourcepacks' : ''; const p = path.join(GAME, d); fs.mkdirSync(p, { recursive: true }); shell.openPath(p); });
ipcMain.on('win', (_, a) => { if (a === 'min') win.minimize(); if (a === 'close') win.close(); });
// Thèmes saisonniers : l'icône de la fenêtre et de la zone de notification change avec le thème
const THEME_ICONS = { halloween: 'logo-halloween.png', christmas: 'logo-noel.png', pride: 'logo-pride.png' };
ipcMain.on('theme', (_, t) => {
  const file = THEME_ICONS[t] || 'sneaky-logo.png';
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', file));
  if (img.isEmpty()) return;
  if (win && !win.isDestroyed()) win.setIcon(img);
  if (tray && !tray.isDestroyed()) tray.setImage(img.resize({ width: 32, height: 32 }));
});

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('pack:refresh', async () => { const r = await refreshPack(); return { ...packInfo(), ok: r.ok, error: r.error }; });
ipcMain.handle('settings:autostart', (_, on) => { on = !!on; saveSettings({ autostart: on }); if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on }); return on; });

// ---- IPC : serveur & Discord ----
// Mesures live (TPS, MSPT, CPU, RAM) publiées par SneakyServer dans la même base Firebase que le manifeste ; le ping, lui, est mesuré ici depuis le PC du joueur
const HOST_RE = /^[A-Za-z0-9.\-]{1,253}(:\d{1,5})?$/;
async function liveStats() {
  try {
    const r = await fetch(cfg().manifestUrl.replace(/manifest\.json.*$/, 'status.json'), { signal: AbortSignal.timeout(4000) });
    const j = r.ok ? await r.json() : null;
    if (j && HOST_RE.test(String(j.ip || ''))) liveIp = j.ip;           // l'IP est gardée même si le serveur est éteint (dernière connue)
    const now = Date.parse(r.headers.get('date') || '') || Date.now();   // heure Firebase : insensible à l'horloge du PC
    return j && j.online && j.updated && now - j.updated < 45000 ? j : null;   // périmé (>45 s) = SneakyServer fermé ou plus de lien
  } catch { return null; }
}
ipcMain.handle('server:status', async () => {
  const l = await liveStats();                                           // d'abord : met à jour l'IP à pinguer
  const ip = cfg().statusIp, s = await serverStatus.status(ip).catch(() => ({ online: false }));
  return s.online ? { ...s, ip, live: l } : { ...s, ip };
});
ipcMain.on('discord', () => shell.openExternal(cfg().discord || DISCORD_URL));
ipcMain.on('copy-ip', () => clipboard.writeText(String(cfg().statusIp)));

// ---- IPC : comptes ----
ipcMain.handle('auth:uuid', (_, n) => (/^\w{3,16}$/.test(String(n || '')) ? offlineUUID(String(n)) : ''));
ipcMain.handle('auth:offline', safe((_, n) => {
  const name = String(n || '').trim();
  if (!/^\w{3,16}$/.test(name)) throw new Error('Pseudo invalide (3 à 16 caractères : lettres, chiffres, _).');
  const acc = { type: 'offline', name, uuid: offlineUUID(name) };
  saveSettings({ account: acc }); return pub(acc);
}));
ipcMain.handle('auth:ms', safe(async () => {
  const xbox = await new Auth('select_account').launch('electron', { width: 520, height: 700 });
  const mc = await xbox.getMinecraft();
  if (!mc.profile) throw new Error('Ce compte Microsoft ne possède pas Minecraft Java Edition.');
  const acc = { type: 'microsoft', name: mc.profile.name, uuid: dash(mc.profile.id) };
  const r = enc(xbox.save()); if (r) acc.refresh = r;
  saveSettings({ account: acc }); return pub(acc);
}));
ipcMain.handle('auth:logout', () => { saveSettings({ account: null }); return true; });

// ---- Modrinth : mods & resource packs ----
const UA = 'SneakyLauncher/1.0 (launcher Sneaky SMP)';
const MR = 'https://api.modrinth.com/v2';
const TYPES = { mod: { dir: 'mods', ext: /\.jar$/i }, resourcepack: { dir: 'resourcepacks', ext: /\.zip$/i } };
const typeDir = (t) => path.join(GAME, TYPES[t].dir);
async function mr(p, params, body) {
  const u = new URL(MR + p);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  const r = await fetch(u, body ? { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Modrinth HTTP ${r.status}`);
  return r.json();
}
const readIndex = () => { const d = readJson(INDEX_FILE, { mod: {}, resourcepack: {} }); d.mod ||= {}; d.resourcepack ||= {}; return d; };
const writeIndex = (d) => fs.writeFileSync(INDEX_FILE, JSON.stringify(d, null, 2));
const bundleNames = (t) => {
  const src = fs.existsSync(path.join(process.resourcesPath || '', 'bundle')) ? path.join(process.resourcesPath, 'bundle') : path.join(__dirname, 'bundle');
  try { return new Set(fs.readdirSync(path.join(src, TYPES[t].dir))); } catch { return new Set(); }
};
const sha = (f, algo) => new Promise((res, rej) => { const h = crypto.createHash(algo); fs.createReadStream(f).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej); });
const hashCache = new Map();

// Liste les fichiers installés et les identifie via Modrinth (empreinte SHA1) quand c'est possible
async function listInstalled() {
  const idx = readIndex(), out = { mod: [], resourcepack: [] };
  for (const t of Object.keys(TYPES)) {
    const dir = typeDir(t), locked = bundleNames(t), meta = managedMeta(t);
    let files = []; try { files = fs.readdirSync(dir); } catch {}
    out[t] = files.filter((f) => TYPES[t].ext.test(f)).map((f) => ({ file: f, title: meta.get(f)?.title || idx[t][f]?.title || f.replace(/\.(jar|zip)$/i, ''), icon: meta.get(f)?.icon || idx[t][f]?.icon || '', id: idx[t][f]?.id || '', locked: locked.has(f) || meta.has(f), path: path.join(dir, f) }));
  }
  try {
    const todo = [...out.mod, ...out.resourcepack].filter((e) => !e.id);
    const byHash = new Map();
    for (const e of todo) {
      const st = fs.statSync(e.path), key = `${e.path}|${st.size}|${st.mtimeMs}`;
      let c = hashCache.get(key); if (!c) { c = { sha1: await sha(e.path, 'sha1') }; hashCache.set(key, c); }
      if (c.pid === undefined) byHash.set(c.sha1, c);
      e.cache = c;
    }
    if (byHash.size) {
      const vf = await mr('/version_files', null, { hashes: [...byHash.keys()], algorithm: 'sha1' });
      for (const [h, c] of byHash) c.pid = vf[h]?.project_id || '';
      const ids = [...new Set([...byHash.values()].map((c) => c.pid).filter(Boolean))];
      if (ids.length) { const ps = await mr('/projects', { ids: JSON.stringify(ids) }); const m = new Map(ps.map((p) => [p.id, p])); for (const c of byHash.values()) c.proj = m.get(c.pid); }
    }
    for (const e of todo) { const c = e.cache; if (c?.pid) { e.id = c.pid; if (c.proj && !e.locked) { e.title = c.proj.title; e.icon = c.proj.icon_url || ''; } } }
  } catch { /* hors-ligne : on garde les noms de fichiers */ }
  for (const t of Object.keys(out)) out[t] = out[t].map(({ path: _p, cache, ...e }) => e);
  return out;
}

async function pickVersion(type, id) {
  const p = { game_versions: JSON.stringify([cfg().mc]) };
  if (type === 'mod') p.loaders = JSON.stringify([cfg().loader]);
  const vs = await mr(`/project/${id}/version`, p);
  return vs.find((v) => v.version_type === 'release') || vs.find((v) => v.version_type === 'beta') || vs[0];
}

async function installProject(type, id, title, icon, have, depth = 0) {
  if (have.has(id)) return;
  const v = await pickVersion(type, id);
  if (!v) throw new Error(`Aucune version compatible (${cfg().mc}${type === 'mod' ? ' / ' + LN[cfg().loader] : ''}) pour « ${title} ».`);
  const f = v.files.find((x) => x.primary) || v.files[0];
  const name = path.basename(f.filename);
  if (!TYPES[type].ext.test(name)) throw new Error(`Fichier inattendu : ${name}`);
  fs.mkdirSync(typeDir(type), { recursive: true });
  const dest = path.join(typeDir(type), name);
  slog(`Téléchargement de ${title}…`);
  await download(f.url, dest + '.part', title);
  if (f.hashes?.sha512 && (await sha(dest + '.part', 'sha512')) !== f.hashes.sha512) { fs.rmSync(dest + '.part', { force: true }); throw new Error(`Fichier corrompu : ${name}`); }
  fs.renameSync(dest + '.part', dest);
  const idx = readIndex(); idx[type][name] = { id, title, icon: icon || '' }; writeIndex(idx);
  have.add(id); slog(`${title} installé.`);
  if (depth < 3) for (const d of v.dependencies || []) {
    if (d.dependency_type !== 'required' || !d.project_id || have.has(d.project_id)) continue;
    try { const p = await mr(`/project/${d.project_id}`); await installProject(type, p.id, p.title, p.icon_url, have, depth + 1); }
    catch (e) { slog(`ERROR Dépendance non installée (${d.project_id}) : ${e.message}`); }
  }
}

let modBusy = false;
ipcMain.handle('mr:search', safe(async (_, { type, query, offset }) => {
  if (!TYPES[type]) throw new Error('Type invalide');
  const facets = [[`project_type:${type}`], [`versions:${cfg().mc}`]];
  if (type === 'mod') facets.push([`categories:${cfg().loader}`], ['client_side:required', 'client_side:optional']);
  const q = String(query || '').slice(0, 80);
  const j = await mr('/search', { query: q, facets: JSON.stringify(facets), limit: 20, offset: Math.max(0, +offset || 0), index: q ? 'relevance' : 'downloads' });
  return { total: j.total_hits, hits: j.hits.map((h) => ({ id: h.project_id, title: h.title, desc: h.description, icon: h.icon_url || '', author: h.author, downloads: h.downloads })) };
}));
ipcMain.handle('mr:list', safe(() => listInstalled()));
ipcMain.handle('mr:install', safe(async (_, { type, id, title, icon }) => {
  if (!TYPES[type] || !/^[A-Za-z0-9]{8}$/.test(String(id))) throw new Error('Requête invalide');
  if (modBusy) throw new Error('Une installation est déjà en cours.');
  modBusy = true;
  try {
    const l = await listInstalled();
    const have = new Set([...l.mod, ...l.resourcepack].map((e) => e.id).filter(Boolean));
    await installProject(type, id, String(title || id), icon, have);
    return true;
  } finally { modBusy = false; send('prog', null); }
}));
ipcMain.handle('mr:remove', safe((_, { type, file }) => {
  if (!TYPES[type]) throw new Error('Type invalide');
  const name = path.basename(String(file || ''));
  if (bundleNames(type).has(name) || managedMeta(type).has(name)) throw new Error('Ce fichier est requis par le serveur.');
  try { fs.rmSync(path.join(typeDir(type), name)); } catch (e) { throw new Error(e.code === 'EBUSY' || e.code === 'EPERM' ? 'Fichier utilisé : ferme Minecraft d’abord.' : e.message); }
  const idx = readIndex(); delete idx[type][name]; writeIndex(idx);
  return true;
}));
