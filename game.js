// Logika gry. Działa w przeglądarce gospodarza (P2P) i w Node (testy).
(function (root) {
  const MAX_HEARTS = 3, START_HEARTS = 2, MAX_PLAYERS = 8;

  const norm = s => String(s).toLowerCase().replace(/ł/g, 'l').normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

  // kategoria -> Map(znormalizowana odpowiedź -> rzadkość 0..1, dalej na liście = rzadsza)
  const loadCats = raw => Object.fromEntries(Object.entries(raw).filter(([k]) => k !== '_info')
    .map(([k, list]) => [k, new Map(list.map((a, i) => [norm(a), i / (list.length - 1)]))]));

  function check(cats, cat, used, text) {
    const n = norm(text);
    if (!n) return { ok: false, why: 'pusto' };
    if (used.has(n)) return { ok: false, why: 'już było' };
    if (!cats[cat].has(n)) return { ok: false, why: 'nie pasuje' };
    return { ok: true, n, rarity: cats[cat].get(n) };
  }

  function addRarity(p, rarity) {
    p.bar += rarity * 0.5; // shortcut: ~2 bardzo rzadkie odpowiedzi = serce; stroić po testach z graczami
    if (p.bar >= 1) { p.bar -= 1; p.hearts = Math.min(MAX_HEARTS, p.hearts + 1); }
  }

  // Pokój prowadzony przez gospodarza. conn = cokolwiek z metodą send(string).
  function createRoom(code, cats) {
    const r = { code, players: [], state: 'lobby', used: new Set(), usedRaw: [], log: [] };
    const me = new Map(); // conn -> gracz
    const alive = () => r.players.filter(p => p.hearts > 0);
    const out = (conn, m) => conn.send(JSON.stringify(m));

    function send() {
      const pub = {
        t: 'state', code, state: r.state, cat: r.cat, holder: r.holder, used: r.usedRaw,
        log: r.log.slice(-6), winner: r.winner,
        players: r.players.map(p => ({ id: p.id, name: p.name, hearts: p.hearts, bar: p.bar, host: p === r.players[0] })),
      };
      for (const p of r.players) out(p.conn, { ...pub, you: p.id });
    }
    function nextHolder() {
      const a = alive(), i = a.findIndex(p => p.id === r.holder);
      r.holder = a[(i + 1) % a.length].id;
    }
    function newRound() {
      const keys = Object.keys(cats);
      r.cat = keys[Math.floor(Math.random() * keys.length)];
      r.used = new Set(); r.usedRaw = [];
      clearTimeout(r.timer);
      r.timer = setTimeout(explode, 10000 + Math.random() * 20000); // ukryty czas: 10–30 s
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

    function onMsg(conn, m) {
      if (m.t === 'join') {
        const name = String(m.name || '').trim().slice(0, 16);
        if (!name) return out(conn, { t: 'err', msg: 'Podaj imię.' });
        if (r.players.length >= MAX_PLAYERS) return out(conn, { t: 'err', msg: 'Pokój pełny.' });
        if (r.state !== 'lobby') return out(conn, { t: 'err', msg: 'Gra już trwa – poczekaj na koniec.' });
        const p = { id: Math.random().toString(36).slice(2), name, hearts: START_HEARTS, bar: 0, conn };
        me.set(conn, p); r.players.push(p);
        r.log.push(`${name} dołącza.`); return send();
      }
      const p = me.get(conn);
      if (!p) return;
      if (m.t === 'start' && p === r.players[0] && r.state === 'lobby' && r.players.length >= 2) {
        r.players.forEach(q => { q.hearts = START_HEARTS; q.bar = 0; });
        r.state = 'game'; r.winner = null; r.holder = r.players[Math.floor(Math.random() * r.players.length)].id;
        r.log.push('Start!'); newRound(); return send();
      }
      if (m.t === 'answer' && r.state === 'game' && r.holder === p.id) {
        const text = String(m.text || '').slice(0, 40);
        const res = check(cats, r.cat, r.used, text);
        if (!res.ok) return out(conn, { t: 'bad', why: res.why });
        r.used.add(res.n); r.usedRaw.push(text.trim());
        addRarity(p, res.rarity);
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

    return { onMsg, onClose, _r: r };
  }

  const api = { norm, loadCats, check, addRarity, createRoom };
  if (typeof module !== 'undefined') module.exports = api; else root.Game = api;
})(this);
