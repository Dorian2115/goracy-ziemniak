const assert = require('assert');
const { norm, loadCats, check, addRarity, createRoom } = require('./game.js');
const raw = require('./kategorie.json');
const CATS = loadCats(raw);

assert.strictEqual(norm('  Łódź '), 'lodz');
assert.strictEqual(norm('Kazimierz  Dolny!'), 'kazimierz dolny');

const used = new Set();
const a = check(CATS, 'Podaj miasto w Polsce', used, 'lodz');
assert.ok(a.ok);
used.add(a.n);
assert.strictEqual(check(CATS, 'Podaj miasto w Polsce', used, 'ŁÓDŹ').why, 'już było');
assert.strictEqual(check(CATS, 'Podaj miasto w Polsce', used, 'Berlin').why, 'nie pasuje');
assert.strictEqual(check(CATS, 'Podaj miasto w Polsce', used, '   ').why, 'pusto');
assert.ok(check(CATS, 'Podaj nazwę owocu', used, 'durian').rarity > check(CATS, 'Podaj nazwę owocu', used, 'jabłko').rarity);

const p = { hearts: 2, bar: 0 };
addRarity(p, 1); addRarity(p, 1);
assert.deepStrictEqual(p, { hearts: 3, bar: 0 });
addRarity(p, 1); addRarity(p, 1);
assert.strictEqual(p.hearts, 3); // limit serc

for (const [k, list] of Object.entries(raw)) if (k !== '_info')
  assert.strictEqual(CATS[k].size, list.length, `duplikat w "${k}"`);

// przebieg pokoju: join, start, odpowiedź przekazuje ziemniaka, tylko gospodarz startuje
const inbox = name => ({ name, got: [], send(s) { this.got.push(JSON.parse(s)); } });
const A = inbox('A'), B = inbox('B'), room = createRoom('TEST', CATS);
room.onMsg(A, { t: 'join', name: 'Ala' });
room.onMsg(B, { t: 'join', name: 'Bob' });
room.onMsg(B, { t: 'start' });
assert.strictEqual(room._r.state, 'lobby'); // Bob nie jest gospodarzem
room.onMsg(A, { t: 'start' });
assert.strictEqual(room._r.state, 'game');
const holder = room._r.holder === room._r.players[0].id ? A : B;
const ans = [...CATS[room._r.cat].keys()][0];
room.onMsg(holder, { t: 'answer', text: ans });
assert.notStrictEqual(room._r.holder, room._r.players[holder === A ? 0 : 1].id);
room.onClose(B);
assert.strictEqual(room._r.state, 'lobby'); // jeden gracz = koniec
clearTimeout(room._r.timer);

console.log('OK – wszystkie testy przeszły');
