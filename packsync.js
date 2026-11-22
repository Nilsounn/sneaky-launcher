'use strict';
// Synchronisation du launcher avec le panel admin : lit le manifeste, installe les mods / resource packs
// obligatoires (empreinte vérifiée), retire ceux qui ne sont plus dans la liste.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const TYPES = { mod: { key: 'mods', dir: 'mods', ext: /\.jar$/i }, resourcepack: { key: 'resourcepacks', dir: 'resourcepacks', ext: /\.zip$/i } };
const ALGOS = new Set(['sha1', 'sha256', 'sha512']);
const RE = { mc: /^\d{1,2}\.\d{1,2}(\.\d{1,2})?$/, nf: /^[\w.+\-]{1,40}$/, host: /^[A-Za-z0-9.\-]{1,253}(:\d{1,5})?$/, discord: /^https:\/\/(discord\.gg|discord\.com\/invite)\/[\w-]{2,40}$/, name: /^[\w.+\-() ]{1,150}$/, hash: /^[0-9a-f]{40,128}$/i };
const MAX_FILE = 500 * 1024 * 1024;
const isLocal = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

function secureUrl(u, allowed) {
  const x = new URL(u);
  if (!(x.protocol === 'https:' || (x.protocol === 'http:' && isLocal(x.hostname)))) throw new Error('URL non sécurisée : ' + x.origin);
  if (allowed && !allowed.has(x.host)) throw new Error('Hôte non autorisé : ' + x.host);
  return x;
}

// Tout ce qui vient du serveur est revalidé ici : versions et noms de fichiers servent à construire des chemins et des URLs.
function validate(m) {
  if (!m || m.schema !== 1) throw new Error('Manifeste invalide');
  const loader = ['neoforge', 'forge', 'fabric'].includes(m.loader) ? m.loader : 'neoforge', lv = String(m.loaderVersion || m.neoforge || '');
  if (!RE.mc.test(String(m.mc)) || !RE.nf.test(lv)) throw new Error('Versions invalides dans le manifeste');
  const out = { schema: 1, revision: +m.revision || 0, mc: m.mc, loader, loaderVersion: lv, strict: !!m.strict };
  if (RE.host.test(String(m.statusIp || ''))) out.statusIp = m.statusIp;
  if (RE.discord.test(String(m.discord || ''))) out.discord = m.discord;
  const n = m.news || {};
  out.news = { title: str(n.title, 120), text: str(n.text, 2000), image: /^https:\/\/\S{1,480}$/.test(n.image || '') ? n.image : '' };
  for (const t of Object.values(TYPES)) {
    const src = Array.isArray(m[t.key]) ? m[t.key] : (m[t.key] && typeof m[t.key] === 'object' ? Object.values(m[t.key]) : []);   // Firebase supprime les listes vides
    const seen = new Set();
    out[t.key] = src.filter(Boolean).slice(0, 500).map((e) => {
      if (!e || !RE.name.test(String(e.file)) || !t.ext.test(e.file) || seen.has(e.file)) throw new Error('Nom de fichier invalide : ' + str(e && e.file, 60));
      seen.add(e.file);
      if (!ALGOS.has(e.algo) || !RE.hash.test(String(e.hash))) throw new Error('Empreinte invalide : ' + e.file);
      if (typeof e.url !== 'string' || e.url.length > 600) throw new Error('URL invalide : ' + e.file);
      return { file: e.file, title: str(e.title, 100) || e.file, icon: /^https:\/\/\S{1,400}$/.test(e.icon || '') ? e.icon : '', url: e.url, algo: e.algo, hash: e.hash.toLowerCase(), size: Number.isFinite(+e.size) ? +e.size : 0 };
    });
  }
  return out;
}

async function fetchManifest(url, timeout = 10000) {
  const u = secureUrl(url);
  const r = await fetch(u, { headers: { 'User-Agent': 'SneakyLauncher', Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('Serveur de mods : HTTP ' + r.status);
  const t = await r.text(); if (t.length > 2e6) throw new Error('Manifeste trop gros');
  return validate(JSON.parse(t));
}

const hashCache = new Map();
function hashFile(f, algo) {
  const st = fs.statSync(f), key = `${algo}|${f}|${st.size}|${st.mtimeMs}`;
  if (hashCache.has(key)) return Promise.resolve(hashCache.get(key));
  return new Promise((res, rej) => { const h = crypto.createHash(algo); fs.createReadStream(f).on('data', (c) => h.update(c)).on('error', rej).on('end', () => { const d = h.digest('hex'); hashCache.set(key, d); res(d); }); });
}
async function upToDate(dest, e) {
  let st; try { st = fs.statSync(dest); } catch { return false; }
  if (e.size && st.size !== e.size) return false;
  return (await hashFile(dest, e.algo)) === e.hash;
}
async function downloadVerified(url, dest, e, onp) {
  const r = await fetch(url, { headers: { 'User-Agent': 'SneakyLauncher' }, signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} pour ${e.title}`);
  const total = +r.headers.get('content-length') || e.size || 0, part = dest + '.part', h = crypto.createHash(e.algo); let n = 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(r.body), new Transform({ transform(c, _, cb) { n += c.length; if (n > MAX_FILE) return cb(new Error('Fichier trop gros')); h.update(c); if (total) onp(Math.min(1, n / total)); cb(null, c); } }), fs.createWriteStream(part));
    if (h.digest('hex') !== e.hash) throw new Error(`Fichier corrompu ou modifié : ${e.file}`);
    fs.renameSync(part, dest);
  } catch (err) { fs.rmSync(part, { force: true }); throw err; }
}

// Mods hébergés par SneakyServer dans la base Firebase (url « blob:<sha256> ») : lus par morceaux base64 sous /blobs/<id>/c/<n>, empreinte vérifiée
async function downloadBlob(origin, id, dest, e, onp) {
  const get = async (k) => { const r = await fetch(`${origin}/blobs/${id}/${k}.json`, { headers: { 'User-Agent': 'SneakyLauncher' }, signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`HTTP ${r.status} pour ${e.title}`); return r.json(); };
  const n = await get('n'); if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('Fichier introuvable sur le serveur : ' + e.title);
  const part = dest + '.part', h = crypto.createHash(e.algo); let size = 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(part, '');
  try {
    for (let i = 0; i < n; i++) {
      const b = Buffer.from(String(await get('c/' + i)), 'base64'); size += b.length;
      if (size > MAX_FILE) throw new Error('Fichier trop gros'); h.update(b); fs.appendFileSync(part, b); onp((i + 1) / n);
    }
    if (h.digest('hex') !== e.hash) throw new Error(`Fichier corrompu ou modifié : ${e.file}`);
    fs.renameSync(part, dest);
  } catch (err) { fs.rmSync(part, { force: true }); throw err; }
}

// keep : { mod:Set, resourcepack:Set } = fichiers à ne jamais déplacer en mode strict (ex. bundle)
const FB_STORAGE = 'firebasestorage.googleapis.com';
async function syncFiles(m, manifestUrl, { gameDir, dataDir, keep = {}, storageBucket = '', onProgress = () => {}, log = () => {} }) {
  const fbPrefix = /^[a-z0-9][a-z0-9._-]{2,100}$/.test(String(storageBucket)) ? `/v0/b/${storageBucket}/o/` : null;   // seul TON bucket est accepté
  const allowed = new Set([new URL(manifestUrl).host, 'cdn.modrinth.com']);
  if (fbPrefix) allowed.add(FB_STORAGE);
  const mf = path.join(dataDir, 'managed.json');
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch {}
  const total = Object.values(TYPES).reduce((s, t) => s + m[t.key].length, 0) || 1, st = { ok: 0, downloaded: 0, removed: 0, moved: 0 }, next = {};
  let done = 0;
  for (const [type, t] of Object.entries(TYPES)) {
    const dir = path.join(gameDir, t.dir); fs.mkdirSync(dir, { recursive: true });
    for (const e of m[t.key]) {
      const dest = path.join(dir, e.file);
      onProgress({ label: `Mods du serveur ${done + 1}/${total}`, ratio: done / total });
      if (await upToDate(dest, e)) st.ok++;
      else {
        log(`Téléchargement : ${e.title}`);
        const prog = (r) => onProgress({ label: e.title, ratio: (done + r) / total });
        if (/^blob:[0-9a-f]{64}$/.test(e.url)) await downloadBlob(secureUrl(manifestUrl).origin, e.url.slice(5), dest, e, prog);
        else {
          const u = secureUrl(new URL(e.url, manifestUrl).href, allowed);
          if (u.host === FB_STORAGE && !u.pathname.startsWith(fbPrefix)) throw new Error('Bucket Firebase non autorisé : ' + e.file);
          await downloadVerified(u.href, dest, e, prog);
        }
        st.downloaded++;
      }
      done++;
    }
    const names = new Set(m[t.key].map((e) => e.file));
    for (const f of prev[type] || []) {            // retirés de la liste : supprimés chez le joueur
      if (names.has(f) || !RE.name.test(f)) continue;
      try { fs.rmSync(path.join(dir, f)); st.removed++; log(`Retiré : ${f}`); } catch (err) { if (err.code !== 'ENOENT') log(`Impossible de retirer ${f} : ${err.code}`); }
    }
    if (m.strict && type === 'mod') {              // mode strict : tout ce qui n'est pas dans la liste part dans mods-unmanaged
      const quarantine = path.join(gameDir, 'mods-unmanaged');
      for (const f of fs.readdirSync(dir)) {
        if (!t.ext.test(f) || names.has(f) || (keep.mod && keep.mod.has(f))) continue;
        fs.mkdirSync(quarantine, { recursive: true });
        let to = path.join(quarantine, f); if (fs.existsSync(to)) to += '.' + Date.now();
        try { fs.renameSync(path.join(dir, f), to); st.moved++; log(`Mod hors liste déplacé : ${f}`); } catch (err) { log(`Impossible de déplacer ${f} : ${err.code}`); }
      }
    }
    next[type] = [...names];
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(mf + '.tmp', JSON.stringify(next)); fs.renameSync(mf + '.tmp', mf);
  return st;
}
module.exports = { validate, fetchManifest, syncFiles, TYPES };
