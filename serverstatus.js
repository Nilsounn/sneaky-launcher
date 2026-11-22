// Statut d'un serveur Minecraft Java via le protocole "Server List Ping" (sans API tierce)
const net = require('net');
const dns = require('dns').promises;

const varint = (n) => { const b = []; do { let t = n & 0x7f; n >>>= 7; if (n) t |= 0x80; b.push(t); } while (n); return Buffer.from(b); };
function readVarint(b, o) {
  let n = 0, s = 0, c;
  do { if (o >= b.length) return null; c = b[o++]; n |= (c & 0x7f) << s; s += 7; if (s > 35) throw new Error('varint invalide'); } while (c & 0x80);
  return [n, o];
}
const flat = (d) => (d == null ? '' : typeof d === 'string' ? d : Array.isArray(d) ? d.map(flat).join('') : (d.text || '') + (d.extra ? flat(d.extra) : ''));

function ping(connectHost, port, handshakeHost, timeout) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: connectHost, port });
    let buf = Buffer.alloc(0), t0 = 0, done = false;
    const end = (fn, v) => { if (done) return; done = true; s.destroy(); fn(v); };
    s.setTimeout(timeout);
    s.on('timeout', () => end(reject, new Error('timeout')));
    s.on('error', (e) => end(reject, e));
    s.on('connect', () => {
      const h = Buffer.from(handshakeHost, 'utf8'), p = Buffer.alloc(2); p.writeUInt16BE(port);
      const data = Buffer.concat([varint(0), varint(767), varint(h.length), h, p, varint(1)]);
      t0 = Date.now();
      s.write(Buffer.concat([varint(data.length), data, Buffer.from([1, 0])]));
    });
    s.on('data', (d) => {
      try {
        buf = Buffer.concat([buf, d]);
        const l = readVarint(buf, 0); if (!l) return;
        if (buf.length < l[1] + l[0]) return;
        const id = readVarint(buf, l[1]), sl = id && readVarint(buf, id[1]);
        if (!sl || id[0] !== 0) return end(reject, new Error('réponse inattendue'));
        const j = JSON.parse(buf.slice(sl[1], sl[1] + sl[0]).toString('utf8'));
        end(resolve, {
          online: true, ping: Date.now() - t0,
          version: (j.version && j.version.name) || '',
          players: { online: (j.players && j.players.online) || 0, max: (j.players && j.players.max) || 0, sample: ((j.players && j.players.sample) || []).map((p) => String(p.name)).slice(0, 8) },
          motd: flat(j.description).replace(/§./g, '').trim()
        });
      } catch (e) { end(reject, e); }
    });
  });
}

async function status(addr, timeout = 5000) {
  let host = String(addr || '').trim(), port = 25565, target = host;
  const m = host.match(/^(.+):(\d{1,5})$/);
  if (m) { host = m[1]; target = host; port = +m[2]; }
  else { try { const r = await dns.resolveSrv('_minecraft._tcp.' + host); if (r && r[0]) { target = r[0].name; port = r[0].port; } } catch { /* pas d'enregistrement SRV */ } }
  if (!host) throw new Error('IP manquante');
  return ping(target, port, host, timeout);
}
module.exports = { status };
