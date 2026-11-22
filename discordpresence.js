// Discord Rich Presence : "Sur le launcher SneakySMP" / "Joue au SneakySMP" + bouton d'invitation
const { Client } = require('@xhayper/discord-rpc');

module.exports = function initPresence({ clientId, getState, getInvite }) {
  const noop = { update() {}, destroy() {} };
  if (!clientId) return noop;
  let client = null, ready = false, last = '', retry = null, deb = null, gameStart = 0;
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

  function apply() {
    if (!ready || !client || !client.user) return;
    const s = getState();
    if (s === last) return;
    last = s;
    const base = {
      largeImageKey: 'logo', largeImageText: 'SneakySMP', instance: false,
      buttons: [{ label: 'Rejoindre le Discord', url: getInvite() }]
    };
    if (s === 'playing') {
      if (!gameStart) gameStart = Date.now();
      client.user.setActivity({ ...base, details: 'Joue au SneakySMP', startTimestamp: gameStart }).catch(() => {});
    } else {
      gameStart = 0;
      if (s === 'launcher') client.user.setActivity({ ...base, details: 'Sur le launcher SneakySMP', startTimestamp: appStart }).catch(() => {});
      else client.user.clearActivity().catch(() => {}); // launcher en arrière-plan et pas de jeu : pas de statut
    }
  }

  connect();
  return {
    update() { clearTimeout(deb); deb = setTimeout(apply, 300); }, // évite le clignotement et le rate-limit Discord
    destroy() { clearTimeout(retry); clearTimeout(deb); if (client) client.destroy().catch(() => {}); }
  };
};
