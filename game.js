// Logika gry. Działa na serwerze (server.js) i w testach.
const MAX_PLAYERS = 8, MIN_PASS_MS = 8000;

const norm = s => String(s).toLowerCase().replace(/ł/g, 'l').normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9+# ]/g, ' ').replace(/\s+/g, ' ').trim();

// {paczka: {kategoria: ["odp|alias", ...]}} -> {cats: {kategoria: {pack, map: Map(wariant -> {key, rarity})}}, packs}
// Dalej na liście = rzadsza odpowiedź (rarity 0..1).
function loadCats(raw) {
  const cats = {};
  for (const [pack, list] of Object.entries(raw)) for (const [cat, answers] of Object.entries(list)) {
    const map = new Map();
    answers.forEach((a, i) => {
      const forms = String(a).split('|').map(norm).filter(Boolean);
      const v = { key: forms[0], rarity: i / Math.max(1, answers.length - 1) };
      for (const f of forms) map.set(f, v);
    });
    cats[cat] = { pack, map };
  }
  return { cats, packs: Object.keys(raw) };
}

// Czy a i b różnią się co najwyżej jedną zmianą (wstawienie, usunięcie, podmiana)?
function near1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

function check(cats, cat, used, text) {
  const n = norm(text);
  if (!n) return { ok: false, why: 'pusto' };
  const map = cats[cat].map;
  let v = map.get(n);
  if (!v && n.length >= 5) { // literówka: uznajemy tylko, gdy pasuje dokładnie jedna odpowiedź
    const keys = new Set();
    for (const [f, x] of map) if (near1(n, f)) keys.add(x);
    if (keys.size === 1) v = [...keys][0];
  }
  if (!v) return { ok: false, why: 'nie pasuje' };
  if (used.has(v.key)) return { ok: false, why: 'już było' };
  return { ok: true, n: v.key, rarity: v.rarity };
}

function addRarity(p, rarity, maxHearts) {
  p.bar += rarity * 0.5; // shortcut: ~2 bardzo rzadkie odpowiedzi = serce; stroić po testach z graczami
  if (p.bar >= 1) { p.bar -= 1; p.hearts = Math.min(maxHearts, p.hearts + 1); }
}

// Po podaniu zostaje tyle czasu, ile było, ale nie mniej niż 8 s.
const fuseAfterPass = ms => Math.max(ms, MIN_PASS_MS);

const clampInt = (v, lo, hi, d) => Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d;

// Pokój. conn = cokolwiek z metodą send(string).
function createRoom(code, { cats, packs }) {
  const r = {
    code, players: [], state: 'lobby', used: new Set(), usedRaw: [], log: [],
    settings: { fuseMin: 10, fuseMax: 30, hearts: 2, packs: [...packs], public: false },
  };
  const me = new Map(); // conn -> gracz
  const alive = () => r.players.filter(p => p.hearts > 0);
  const out = (conn, m) => conn.send(JSON.stringify(m));
  const packInfo = packs.map(name => ({ name, n: Object.values(cats).filter(c => c.pack === name).length }));

  function send() {
    const pub = {
      t: 'state', code, state: r.state, cat: r.cat, round: r.round, holder: r.holder, used: r.usedRaw,
      log: r.log.slice(-6), winner: r.winner, settings: r.settings, packs: packInfo,
      players: r.players.map(p => ({ id: p.id, name: p.name, hearts: p.hearts, bar: p.bar, waiting: p.waiting, host: p === r.players[0] })),
    };
    for (const p of r.players) out(p.conn, { ...pub, you: p.id });
  }
  function fuse(ms) {
    clearTimeout(r.timer);
    r.deadline = Date.now() + ms;
    r.timer = setTimeout(explode, ms);
  }
  function nextHolder() {
    const a = alive(), i = a.findIndex(p => p.id === r.holder);
    r.holder = a[(i + 1) % a.length].id;
  }
  function newRound() {
    let keys = Object.keys(cats).filter(k => r.settings.packs.includes(cats[k].pack));
    if (keys.length > 1) keys = keys.filter(k => k !== r.cat);
    r.cat = keys[Math.floor(Math.random() * keys.length)];
    r.used = new Set(); r.usedRaw = []; r.round = (r.round || 0) + 1;
    const { fuseMin, fuseMax } = r.settings;
    fuse((fuseMin + Math.random() * (fuseMax - fuseMin)) * 1000); // ukryty czas
  }
  function explode() {
    const p = r.players.find(p => p.id === r.holder);
    if (p) { p.hearts--; r.log.push(`💥 Ziemniak wybuchł u ${p.name}!`); }
    if (alive().length <= 1) return endGame();
    nextHolder(); newRound(); send();
  }
  function endGame() {
    clearTimeout(r.timer);
    const w = alive()[0];
    r.state = 'lobby'; r.winner = w ? w.name : null;
    r.log.push(w ? `🏆 Wygrywa ${w.name}!` : 'Koniec gry.');
    send();
  }
  function setSettings(m) {
    const s = r.settings;
    s.fuseMin = clampInt(m.fuseMin, 5, 60, s.fuseMin);
    s.fuseMax = Math.max(s.fuseMin, clampInt(m.fuseMax, 5, 60, s.fuseMax));
    s.hearts = clampInt(m.hearts, 1, 5, s.hearts);
    const chosen = Array.isArray(m.packs) ? packs.filter(p => m.packs.includes(p)) : [];
    if (chosen.length) s.packs = chosen;
    s.public = !!m.public;
  }

  function onMsg(conn, m) {
    if (m.t === 'join') {
      if (me.has(conn)) return;
      const name = String(m.name || '').trim().slice(0, 16);
      if (!name) return out(conn, { t: 'err', msg: 'Podaj imię.' });
      if (r.players.length >= MAX_PLAYERS) return out(conn, { t: 'err', msg: 'Pokój pełny.' });
      const waiting = r.state !== 'lobby'; // w trakcie gry: ogląda i wchodzi do następnej
      const p = { id: Math.random().toString(36).slice(2), name, hearts: waiting ? 0 : r.settings.hearts, bar: 0, waiting, conn };
      me.set(conn, p); r.players.push(p);
      r.log.push(waiting ? `${name} dołącza i czeka na następną grę.` : `${name} dołącza.`); return send();
    }
    const p = me.get(conn);
    if (!p) return;
    const host = p === r.players[0];
    if (m.t === 'settings' && host && r.state === 'lobby') { setSettings(m); return send(); }
    if (m.t === 'start' && host && r.state === 'lobby' && r.players.length >= 2) {
      r.players.forEach(q => { q.hearts = r.settings.hearts; q.bar = 0; q.waiting = false; });
      r.state = 'game'; r.winner = null; r.round = 0; r.holder = r.players[Math.floor(Math.random() * r.players.length)].id;
      r.log = ['Start!']; newRound(); return send(); // ogłoszenia z lobby znikają po starcie
    }
    if (m.t === 'answer' && r.state === 'game' && r.holder === p.id) {
      const text = String(m.text || '').slice(0, 40);
      const res = check(cats, r.cat, r.used, text);
      if (!res.ok) return out(conn, { t: 'bad', why: res.why });
      r.used.add(res.n); r.usedRaw.push(text.trim());
      addRarity(p, res.rarity, r.settings.hearts + 1);
      const left = r.deadline - Date.now();
      if (fuseAfterPass(left) !== left) fuse(fuseAfterPass(left));
      nextHolder(); send();
    }
  }

  function onClose(conn) {
    const p = me.get(conn); if (!p) return;
    me.delete(conn);
    if (r.holder === p.id && r.state === 'game' && alive().length > 1) nextHolder();
    r.players = r.players.filter(q => q !== p);
    r.log.push(`${p.name} wychodzi.`);
    if (!r.players.length) return clearTimeout(r.timer);
    if (r.state === 'game' && alive().length <= 1) return endGame();
    send();
  }

  const info = () => ({ code, players: r.players.length, state: r.state, public: r.settings.public });
  return { onMsg, onClose, info, _r: r };
}

module.exports = { norm, near1, loadCats, check, addRarity, fuseAfterPass, createRoom, MAX_PLAYERS };
