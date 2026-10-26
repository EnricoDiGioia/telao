// Telão — servidor de sinalização
// Serve o site (pasta public/) e troca as mensagens de conexão entre quem está na mesma sala.
// O vídeo em si NÃO passa por aqui: vai direto de um navegador para o outro (WebRTC).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PER_ROOM = Number(process.env.MAX_PER_ROOM) || 8;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// ---------- Site estático ----------
const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (pathname === '/') pathname = '/index.html';

  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- Servidores ICE (STUN/TURN) ----------
function iceServers() {
  const list = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  return list;
}

// ---------- Sinalização ----------
const rooms = new Map(); // nomeDaSala -> Map(id -> { ws, name, streams })

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws) => {
  const id = crypto.randomUUID().slice(0, 8);
  let roomName = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join' && !roomName) {
      const room = String(msg.room || 'geral').trim().slice(0, 64) || 'geral';
      const name = String(msg.name || 'Anônimo').trim().slice(0, 32) || 'Anônimo';
      if (!rooms.has(room)) rooms.set(room, new Map());
      const members = rooms.get(room);

      if (members.size >= MAX_PER_ROOM) {
        send(ws, { type: 'full', max: MAX_PER_ROOM });
        return ws.close();
      }

      roomName = room;
      send(ws, {
        type: 'welcome',
        id,
        iceServers: iceServers(),
        peers: [...members].map(([pid, m]) => ({ id: pid, name: m.name, streams: m.streams })),
      });
      for (const m of members.values()) send(m.ws, { type: 'peer-joined', id, name });
      members.set(id, { ws, name, streams: {} });
      console.log(`[${room}] ${name} entrou (${members.size} na sala)`);
      return;
    }

    if (!roomName) return;
    const members = rooms.get(roomName);
    if (!members) return;
    const me = members.get(id);

    if (msg.type === 'signal') {
      const target = members.get(String(msg.to));
      if (target) send(target.ws, { type: 'signal', from: id, data: msg.data });
    } else if (msg.type === 'meta') {
      if (me) {
        if (msg.name) me.name = String(msg.name).slice(0, 32);
        me.streams = msg.streams && typeof msg.streams === 'object' ? msg.streams : {};
      }
      for (const [pid, m] of members) {
        if (pid !== id) send(m.ws, { type: 'meta', from: id, name: me?.name, streams: me?.streams || {} });
      }
    }
  });

  ws.on('close', () => {
    if (!roomName) return;
    const members = rooms.get(roomName);
    if (!members) return;
    const me = members.get(id);
    members.delete(id);
    for (const m of members.values()) send(m.ws, { type: 'peer-left', id });
    console.log(`[${roomName}] ${me?.name || id} saiu (${members.size} na sala)`);
    if (members.size === 0) rooms.delete(roomName);
  });
});

// Mantém a conexão viva (túneis e proxies derrubam conexões paradas)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Telão rodando!');
  console.log(`  Abra no seu navegador:  http://localhost:${PORT}`);
  console.log('  Para seus amigos entrarem pela internet, veja o README (seção "Acesso pela internet").');
  console.log('');
});
