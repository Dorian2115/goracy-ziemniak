// Serwer gry: statyczne pliki + WebSocket. Uruchom: npm start
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Game = require('./game.js');

const dir = path.join(__dirname, 'kategorie');
const raw = Object.fromEntries(fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
  .map(f => [path.basename(f, '.json'), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]));
const CATS = Game.loadCats(raw);
const rooms = new Map(); // kod -> pokój

const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'] };
const cleanCode = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

function start(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/rooms') {
      const list = [...rooms.values()].map(r => r.info()).filter(r => r.public);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(list));
    }
    const f = FILES[url.pathname];
    if (!f) { res.writeHead(404); return res.end('Nie ma takiej strony'); }
    res.writeHead(200, { 'content-type': f[1] });
    fs.createReadStream(path.join(__dirname, f[0])).pipe(res);
  });

  const wss = new WebSocketServer({ server, maxPayload: 2048 });
  wss.on('connection', ws => {
    let room = null, code = null;
    ws.on('message', data => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (!room) {
        if (m.t !== 'join') return;
        code = cleanCode(m.code);
        if (!code) return ws.send(JSON.stringify({ t: 'err', msg: 'Podaj kod pokoju.' }));
        room = rooms.get(code) || rooms.set(code, Game.createRoom(code, CATS)).get(code);
      }
      try { room.onMsg(ws, m); } catch (e) { console.error(e); }
    });
    ws.on('close', () => {
      if (!room) return;
      room.onClose(ws);
      if (!room.info().players && rooms.get(code) === room) rooms.delete(code);
    });
  });

  return new Promise(ok => server.listen(port, () => ok(server)));
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  start(port).then(() => console.log(`Gorący Ziemniak: http://localhost:${port}`));
}
module.exports = { start, rooms };
