/* ===== Thèmes saisonniers de Sneaky =====
   Automatique : octobre = halloween, décembre = christmas, juin = pride.
   Secret : taper "scary", "christmas" ou "pride" n'importe où dans le launcher (hors champ de saisie).
   Retaper le même code désactive le thème secret (retour au mode automatique). */
(function () {
  'use strict';
  var KEY = 'sneaky.theme';
  var MONTHS = { 5: 'pride', 9: 'halloween', 11: 'christmas' };           // getMonth() : juin=5, octobre=9, décembre=11
  var CODES = { scary: 'halloween', christmas: 'christmas', pride: 'pride' };
  var THEMES = {
    halloween: { logo: '../assets/logo-halloween.png', embers: ['#ff8a1f', '#ff4a1f', '#ffd23f'], fx: 'bats', toast: '🎃 Thème Halloween activé' },
    christmas: { logo: '../assets/logo-noel.png', embers: ['#ffffff', '#cfe6ff', '#8fc4ff'], fx: 'snow', snow: true, toast: '❄️ Thème Noël activé' },
    pride:     { logo: '../assets/logo-pride.png', embers: ['#ff3b3b', '#ff9d2e', '#ffe135', '#3ddc4a', '#2e9bff', '#a24bff'], fx: null, toast: '🏳️‍🌈 Thème Pride activé' }
  };
  var root = document.documentElement;

  function stored() { try { var v = localStorage.getItem(KEY); return THEMES[v] ? v : null; } catch (e) { return null; } }
  function store(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) {} }
  function resolve() { return stored() || MONTHS[new Date().getMonth()] || null; }

  var current = null;

  function apply(name) {
    current = name;
    var t = name && THEMES[name];
    if (t) root.setAttribute('data-theme', name); else root.removeAttribute('data-theme');
    window.sneakyTheme = t ? { name: name, embers: t.embers, snow: !!t.snow } : { name: null };
    var logo = document.getElementById('barlogo');
    if (logo) logo.src = t ? t.logo : '../assets/sneaky-logo.png';
    startFx(t && t.fx);
    try { if (window.sneaky && typeof window.sneaky.setTheme === 'function') window.sneaky.setTheme(name || ''); } catch (e) {}
  }

  /* ---------- effets : chauves-souris & neige (un seul canvas plein écran) ---------- */
  var cv = null, cx = null, mode = null, raf = 0, W = 0, H = 0, last = 0, items = [];

  function ensureCanvas() {
    if (cv) return;
    cv = document.createElement('canvas'); cv.id = 'fx'; document.body.appendChild(cv);
    cx = cv.getContext('2d');
    window.addEventListener('resize', size); size();
  }
  function size() {
    if (!cv) return;
    W = cv.width = window.innerWidth; H = cv.height = window.innerHeight; cx.imageSmoothingEnabled = false;
  }

  /* sprite de chauve-souris : moitié gauche (centre = dernière colonne), miroir automatique */
  var BAT_HALF = [
    [ // ailes en haut
      '#........',
      '##.....#.',
      '###....##',
      '####..#e#',
      '.########',
      '..###.###',
      '...#..#..'
    ],
    [ // ailes en bas
      '.........',
      '.......#.',
      '......###',
      '..#..#e##',
      '.########',
      '####..###',
      '###...##.',
      '#.....#..'
    ]
  ];
  var batFrames = null;
  function buildBats() {
    batFrames = BAT_HALF.map(function (half) {
      var rows = half.map(function (r) { return r + r.slice(0, 8).split('').reverse().join(''); });
      var w = 17, h = rows.length, c = document.createElement('canvas'); c.width = w; c.height = 8;
      var g = c.getContext('2d');
      rows.forEach(function (row, y) {
        for (var x = 0; x < w; x++) {
          var ch = row[x]; if (ch === '#') { g.fillStyle = '#1a0d12'; g.fillRect(x, y, 1, 1); }
          else if (ch === 'e') { g.fillStyle = '#ff9a2e'; g.fillRect(x, y, 1, 1); }
        }
      });
      return c;
    });
  }

  function newBat(first) {
    var dir = Math.random() < .5 ? 1 : -1, sc = 2 + Math.floor(Math.random() * 3);   // taille 2 à 4
    return {
      dir: dir, sc: sc, base: 50 + Math.random() * Math.max(40, H - 160), amp: 14 + Math.random() * 40,
      freq: .8 + Math.random() * 1.4, ph: Math.random() * 6.28, spd: 45 + Math.random() * 70, t: 0,
      fl: Math.random() * 1, flapRate: 7 + Math.random() * 5,
      x: first ? Math.random() * W : (dir > 0 ? -60 : W + 60)
    };
  }
  function drawBat(b) {
    var f = batFrames[((Math.floor(b.fl) % 2) + 2) % 2], w = 17 * b.sc, h = 8 * b.sc,
        y = b.base + Math.sin(b.t * b.freq + b.ph) * b.amp;
    cx.save(); cx.translate(Math.round(b.x), Math.round(y));
    if (b.dir < 0) cx.scale(-1, 1);
    cx.drawImage(f, -w / 2, -h / 2, w, h); cx.restore();
  }

  function newFlake(first) {
    var big = Math.random() < .22;
    return { x: Math.random() * W, y: first ? Math.random() * H : -10, big: big, s: big ? 3 : (Math.random() < .5 ? 2 : 3),
      vy: (big ? 38 : 22) + Math.random() * 34, sw: 10 + Math.random() * 24, f: .6 + Math.random() * 1.2, ph: Math.random() * 6.28,
      a: .55 + Math.random() * .45, t: 0 };
  }
  function drawFlake(p) {
    var x = Math.round(p.x + Math.sin(p.t * p.f + p.ph) * p.sw), y = Math.round(p.y), s = p.s;
    cx.globalAlpha = p.a; cx.fillStyle = '#fff';
    if (p.big) { cx.fillRect(x, y - s, s, s * 3); cx.fillRect(x - s, y, s * 3, s); }   // petit flocon en croix
    else cx.fillRect(x, y, s, s);
    cx.globalAlpha = 1;
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    var dt = Math.max(0, Math.min(.05, (now - last) / 1000)); last = now;
    if (document.hidden) return;
    cx.clearRect(0, 0, W, H);
    if (mode === 'bats') {
      for (var i = 0; i < items.length; i++) {
        var b = items[i]; b.t += dt; b.fl += dt * b.flapRate; b.x += b.dir * b.spd * dt;
        if ((b.dir > 0 && b.x > W + 70) || (b.dir < 0 && b.x < -70)) { items[i] = b = newBat(false); }
        drawBat(b);
      }
    } else if (mode === 'snow') {
      for (var j = 0; j < items.length; j++) {
        var p = items[j]; p.t += dt; p.y += p.vy * dt;
        if (p.y > H + 10) items[j] = p = newFlake(false);
        drawFlake(p);
      }
    }
  }

  function startFx(kind) {
    cancelAnimationFrame(raf); raf = 0; items = []; mode = kind || null;
    if (!kind) { if (cv) { cv.remove(); cv = null; cx = null; } return; }
    if (!document.body) return;
    ensureCanvas(); size();
    if (kind === 'bats') { if (!batFrames) buildBats(); for (var i = 0; i < 8; i++) items.push(newBat(true)); }
    if (kind === 'snow') { var n = Math.max(60, Math.round(W * H / 9000)); for (var j = 0; j < n; j++) items.push(newFlake(true)); }
    last = performance.now(); raf = requestAnimationFrame(loop);
  }

  /* ---------- code secret ---------- */
  var buf = '', bufT = 0, toastT = 0;
  function toast(msg) {
    var t = document.getElementById('themeToast');
    if (!t) { t = document.createElement('div'); t.id = 'themeToast'; document.body.appendChild(t); }
    t.textContent = msg; void t.offsetWidth; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 2200);
  }
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    var tg = e.target; if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) { buf = ''; return; }
    var now = Date.now(); if (now - bufT > 2500) buf = ''; bufT = now;
    buf = (buf + e.key.toLowerCase()).slice(-12);
    for (var code in CODES) {
      if (buf.slice(-code.length) === code) {
        buf = ''; var name = CODES[code];
        if (stored() === name) { store(null); apply(resolve()); toast('Thème secret désactivé'); }
        else { store(name); apply(name); toast(THEMES[name].toast); }
        return;
      }
    }
  }

  apply(resolve());                                   // attribut posé tout de suite : pas de flash de couleurs
  document.addEventListener('DOMContentLoaded', function () { apply(current); });
  document.addEventListener('keydown', onKey);
})();
