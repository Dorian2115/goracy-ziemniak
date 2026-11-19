const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { norm, near1, loadCats, check, addRarity, fuseAfterPass, createRoom } = require('./game.js');

const dir = path.join(__dirname, 'kategorie');
const raw = Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  .map(f => [path.basename(f, '.json'), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]));
const DATA = loadCats(raw), CATS = DATA.cats;

// --- dane: każda kategoria ma min. 40 odpowiedzi, żaden wariant nie powtarza się w kategorii
let total = 0;
for (const [pack, list] of Object.entries(raw)) for (const [cat, answers] of Object.entries(list)) {
  total++;
  assert.ok(answers.length >= 40, `za mało odpowiedzi (${answers.length}) w "${cat}"`);
  const seen = new Map();
  for (const a of answers) for (const f of a.split('|').map(norm)) {
    assert.ok(f, `pusty wariant w "${cat}": "${a}"`);
    assert.ok(!seen.has(f) || seen.get(f) === a, `duplikat "${f}" w "${cat}" (${pack}): "${seen.get(f)}" i "${a}"`);
    seen.set(f, a);
  }
}
assert.ok(total >= 100, `kategorii: ${total}`);

// --- normalizacja, aliasy, literówki
assert.strictEqual(norm('  Łódź '), 'lodz');
assert.strictEqual(norm('Kazimierz  Dolny!'), 'kazimierz dolny');
assert.ok(near1('banan', 'bananm') && near1('banan', 'baan') && near1('banan', 'banam') && !near1('banan', 'bnaam'));

const OWOC = 'Podaj nazwę owocu', MIASTO = 'Podaj miasto w Polsce';
const used = new Set();
const a = check(CATS, MIASTO, used, 'lodz');
assert.ok(a.ok);
used.add(a.n);
assert.strictEqual(check(CATS, MIASTO, used, 'ŁÓDŹ').why, 'już było');
assert.strictEqual(check(CATS, MIASTO, used, 'Berlin').why, 'nie pasuje');
assert.strictEqual(check(CATS, MIASTO, used, '   ').why, 'pusto');
assert.ok(check(CATS, OWOC, used, 'durian').rarity > check(CATS, OWOC, used, 'jabłko').rarity);
const u2 = new Set([check(CATS, OWOC, new Set(), 'pomarańcza').n]);
assert.strictEqual(check(CATS, OWOC, u2, 'pomarańcz').why, 'już było'); // alias = ta sama odpowiedź
assert.ok(check(CATS, OWOC, new Set(), 'pomarancz').ok);
assert.ok(check(CATS, OWOC, new Set(), 'bananm').ok); // literówka
assert.strictEqual(check(CATS, OWOC, new Set(), 'kiwo').why, 'nie pasuje'); // za krótkie na literówkę

// --- serca i lont
const p = { hearts: 2, bar: 0 };
addRarity(p, 1, 3); addRarity(p, 1, 3);
assert.deepStrictEqual(p, { hearts: 3, bar: 0 });
addRarity(p, 1, 3); addRarity(p, 1, 3);
assert.strictEqual(p.hearts, 3); // limit serc
assert.strictEqual(fuseAfterPass(3000), 8000);
assert.strictEqual(fuseAfterPass(15000), 15000);

// --- przebieg pokoju
const inbox = name => ({ name, got: [], send(s) { this.got.push(JSON.parse(s)); }, last() { return this.got.filter(m => m.t === 'state').pop(); } });
const A = inbox('A'), B = inbox('B'), C = inbox('C'), room = createRoom('TEST', DATA);
room.onMsg(A, { t: 'join', name: 'Ala' });
room.onMsg(B, { t: 'join', name: 'Bob' });

// ustawienia: tylko gospodarz, wartości przycięte
room.onMsg(B, { t: 'settings', fuseMin: 7, fuseMax: 7, hearts: 4, packs: ['Polska'] });
assert.strictEqual(room._r.settings.hearts, 2);
room.onMsg(A, { t: 'settings', fuseMin: 1, fuseMax: 999, hearts: 99, packs: ['Polska', 'nie ma'], public: true });
assert.deepStrictEqual(room._r.settings, { fuseMin: 5, fuseMax: 60, hearts: 5, packs: ['Polska'], public: true });
room.onMsg(A, { t: 'settings', fuseMin: 40, fuseMax: 10, hearts: 3, packs: [] });
assert.strictEqual(room._r.settings.fuseMax, 40); // max nie mniejszy niż min
assert.deepStrictEqual(room._r.settings.packs, ['Polska']); // pusta lista = bez zmian
assert.strictEqual(room.info().public, false);

room.onMsg(B, { t: 'start' });
assert.strictEqual(room._r.state, 'lobby'); // Bob nie jest gospodarzem
room.onMsg(A, { t: 'start' });
assert.strictEqual(room._r.state, 'game');
assert.strictEqual(CATS[room._r.cat].pack, 'Polska');
assert.ok(room._r.players.every(q => q.hearts === 3));

// dołączenie w trakcie gry: czeka bez serc
room.onMsg(C, { t: 'join', name: 'Cel' });
const cel = room._r.players[2];
assert.ok(cel.waiting && cel.hearts === 0);

// podanie przy niskim czasie podnosi lont do 8 s
room._r.deadline = Date.now() + 1000;
const holder = room._r.holder === room._r.players[0].id ? A : B;
const ans = [...CATS[room._r.cat].map.keys()][0];
room.onMsg(holder, { t: 'answer', text: ans });
assert.notStrictEqual(room._r.holder, room._r.players[holder === A ? 0 : 1].id);
assert.notStrictEqual(room._r.holder, cel.id); // czekający nie dostaje ziemniaka
assert.ok(room._r.deadline - Date.now() > 7000);

// gospodarz wychodzi: gra trwa, gospodarzem zostaje następna osoba
room.onClose(A);
assert.strictEqual(room._r.state, 'lobby'); // został jeden żywy gracz = koniec
assert.ok(B.last().players[0].host && B.last().players[0].name === 'Bob');
room.onMsg(B, { t: 'start' }); // Bob jest teraz gospodarzem; Cel dostaje serca
assert.strictEqual(room._r.state, 'game');
assert.ok(!cel.waiting && cel.hearts === 3);
clearTimeout(room._r.timer);

// --- serwer: dwóch klientów przez WebSocket
(async () => {
  const { start, rooms } = require('./server.js');
  const server = await start(0);
  const url = `ws://localhost:${server.address().port}`;
  const client = () => new Promise(ok => {
    const ws = new WebSocket(url); ws.msgs = [];
    ws.on('message', d => ws.msgs.push(JSON.parse(d)));
    ws.on('open', () => ok(ws));
  });
  const until = (ws, fn) => new Promise((ok, no) => {
    const t = setInterval(() => { const m = ws.msgs.find(fn); if (m) { clearInterval(t); ok(m); } }, 10);
    setTimeout(() => { clearInterval(t); no(new Error('brak odpowiedzi serwera')); }, 2000);
  });
  const x = await client(), y = await client();
  x.send(JSON.stringify({ t: 'join', code: 'ab-12', name: 'X' }));
  await until(x, m => m.t === 'state');
  x.send(JSON.stringify({ t: 'settings', public: true, fuseMin: 10, fuseMax: 30, hearts: 2, packs: DATA.packs }));
  y.send(JSON.stringify({ t: 'join', code: 'AB12', name: 'Y' }));
  await until(y, m => m.t === 'state' && m.players.length === 2);
  const list = await (await fetch(`http://localhost:${server.address().port}/rooms`)).json();
  assert.deepStrictEqual(list, [{ code: 'AB12', players: 2, state: 'lobby', public: true }]);
  x.send(JSON.stringify({ t: 'start' }));
  await until(x, m => m.state === 'game');
  await until(y, m => m.state === 'game');
  assert.ok(!JSON.stringify(y.msgs).includes('"map"')); // odpowiedzi nie wyciekają do klienta
  x.close(); y.close();
  await new Promise(ok => setTimeout(ok, 100));
  assert.strictEqual(rooms.size, 0); // pusty pokój usunięty
  server.close();
  console.log(`OK – wszystkie testy przeszły (${total} kategorii)`);
})().catch(e => { console.error(e); process.exit(1); });
