// Discord Rich Presence : "Sur le launcher SneakySMP" / "Joue au SneakySMP", lignes animées, bouton + liens d'invitation
const { Client } = require('@xhayper/discord-rpc');

module.exports = function initPresence({ clientId, getState, getInvite, getInfo }) {
  const noop = { update() {}, destroy() {} };
  if (!clientId) return noop;
  let client = null, ready = false, last = '', cur = '', retry = null, deb = null, gameStart = 0, frame = 0, info = null, infoAt = 0;
  const appStart = Date.now();

  const schedule = () => { clearTimeout(retry); retry = setTimeout(connect, 30000); };
  async function connect() {
    clearTimeout(retry);
    try { if (client) await client.destroy().catch(() => {}); } catch { /* ignoré */ }
    ready = false; last = '';
    try {
      client = new Client({ clientId });
      client.on('ready', () => { ready = true; last = ''; apply(); });
      client.on('disconnected', () => { ready = false; schedule(); });
      await client.login();
    } catch { ready = false; schedule(); } // Discord fermé : on réessaie toutes les 30 s
  }

  async function refreshInfo() { // infos serveur mises en cache 30 s
    if (Date.now() - infoAt < 30000) return;
    infoAt = Date.now();
    try { info = await getInfo(); } catch { info = null; }
  }
  // Lignes qui défilent toutes les 15 s sous le titre (Discord n'autorise pas d'animation, on fait tourner le texte)
  const lines = (s) => {
    const L = [s === 'playing' ? 'Dans le monde du SMP' : 'Prêt à jouer'];
    if (info) {
      L.push(info.online ? '🟢 Serveur en ligne' + (info.ping ? ' · ' + info.ping + ' ms' : '') : '🔴 Serveur hors ligne');
      if (info.online && info.tps != null) L.push('⚡ TPS ' + (+info.tps).toFixed(1));
      if (info.mc) L.push('⛏ Minecraft ' + info.mc + (info.loader ? ' · ' + info.loader : ''));
    }
    return L;
  };

  function send(s) {
    if (!ready || !client || !client.user || getState() !== s) return;
    const L = lines(s), text = L[frame % L.length], inv = getInvite();
    const pl = info && info.online && info.players;
    const party = pl && pl.online >= 1 && pl.max >= pl.online ? { partyId: 'sneaky-smp', partySize: pl.online, partyMax: pl.max } : {};
    const key = [s, text, party.partySize || 0, party.partyMax || 0, inv].join('|');
    if (key === last) return;
    last = key;
    if (s === 'playing' && !gameStart) gameStart = Date.now();
    client.user.setActivity({
      details: s === 'playing' ? 'Joue au SneakySMP' : 'Sur le launcher SneakySMP',
      state: text,
      detailsUrl: inv, stateUrl: inv,                                  // le texte est cliquable (visible aussi sur ton propre profil)
      largeImageKey: 'logo', largeImageText: 'SneakySMP · clique pour rejoindre le Discord', largeImageUrl: inv,
      startTimestamp: s === 'playing' ? gameStart : appStart,
      statusDisplayType: 2,                                            // la liste des membres affiche « Joue au SneakySMP » (details) au lieu du nom de l'app
      buttons: [{ label: 'Rejoindre le Discord', url: inv }],         // visible par les AUTRES (Discord le cache sur ton propre profil)
      instance: false, ...party
    }).catch(() => {});
  }

  function apply() {
    if (!ready || !client || !client.user) return;
    const s = getState();
    if (s !== cur) { cur = s; frame = 0; last = ''; }
    if (s === 'none') { // launcher fermé en arrière-plan (zone de notification) : plus de statut
      gameStart = 0;
      if (last !== 'none') { last = 'none'; client.user.clearActivity().catch(() => {}); }
      return;
    }
    refreshInfo().then(() => send(s));
  }

  const tick = setInterval(() => { frame++; apply(); }, 15000);
  connect();
  return {
    update() { clearTimeout(deb); deb = setTimeout(apply, 300); }, // évite le clignotement et le rate-limit Discord
    destroy() { clearTimeout(retry); clearTimeout(deb); clearInterval(tick); if (client) client.destroy().catch(() => {}); }
  };
};
