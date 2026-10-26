// Telão — versão Cloudflare Workers
// O site (pasta public/) é servido pela Cloudflare. Cada sala é um Durable Object
// que só troca as mensagens de conexão; o vídeo vai direto entre os navegadores.

import { DurableObject } from 'cloudflare:workers';

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Esta rota só aceita WebSocket', { status: 426 });
      }
      const room = (url.searchParams.get('sala') || 'geral').trim().slice(0, 64) || 'geral';
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

// Servidores para atravessar a rede de cada um:
// - STUN: descobre o endereço público (conexão direta, a maioria dos casos)
// - TURN da Cloudflare: retransmite o vídeo quando a rede bloqueia conexão direta
//   (CGNAT, 4G, firewall). Precisa de TURN_KEY_ID (em wrangler.toml) e do segredo
//   TURN_KEY_API_TOKEN. As credenciais geradas valem 24 h e ficam guardadas por 12 h.
let turnCache = null; // { servers, until }

async function iceServers(env) {
  const list = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    if (!turnCache || turnCache.until < Date.now()) {
      try {
        const res = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ttl: 86400 }),
          }
        );
        if (res.ok) {
          const data = await res.json();
          const servers = (data.iceServers || [])
            .map((s) => {
              const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
                // navegadores bloqueiam a porta 53: tira para não esperar à toa
                .filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u));
              return { ...s, urls };
            })
            .filter((s) => s.urls.length && s.urls.some((u) => u.startsWith('turn')));
          if (servers.length) turnCache = { servers, until: Date.now() + 12 * 3600 * 1000 };
        } else {
          console.log('TURN: a Cloudflare recusou gerar credenciais', res.status);
        }
      } catch (err) {
        console.log('TURN: falha ao gerar credenciais', String(err));
      }
    }
    if (turnCache) list.push(...turnCache.servers);
  }

  // TURN de outro provedor (opcional)
  if (env.TURN_URL) {
    list.push({
      urls: String(env.TURN_URL).split(',').map((s) => s.trim()),
      username: env.TURN_USER || '',
      credential: env.TURN_PASS || '',
    });
  }
  return list;
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    // Responde o "ping" do navegador sem acordar o objeto (não conta no limite grátis)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID().slice(0, 8), joined: false, name: '', streams: {} });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Quem já entrou na sala (opcionalmente ignorando uma conexão)
  members(except) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      let a;
      try { a = ws.deserializeAttachment(); } catch { continue; }
      if (a && a.joined) out.push({ ws, a });
    }
    return out;
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 256 * 1024) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment();
    if (!me) return;

    if (msg.type === 'join' && !me.joined) {
      // Primeiro as credenciais (pode precisar falar com a Cloudflare); depois olha quem está na sala
      const ice = await iceServers(this.env);
      const fresh = ws.deserializeAttachment();
      if (!fresh || fresh.joined) return;
      const max = Number(this.env.MAX_PER_ROOM) || 8;
      const others = this.members(ws);
      if (others.length >= max) {
        this.send(ws, { type: 'full', max });
        ws.close(1008, 'Sala cheia');
        return;
      }
      me.joined = true;
      me.name = String(msg.name || 'Anônimo').trim().slice(0, 32) || 'Anônimo';
      ws.serializeAttachment(me);

      this.send(ws, {
        type: 'welcome',
        id: me.id,
        iceServers: ice,
        peers: others.map(({ a }) => ({ id: a.id, name: a.name, streams: a.streams })),
      });
      for (const { ws: other } of others) this.send(other, { type: 'peer-joined', id: me.id, name: me.name });
      return;
    }

    if (!me.joined) return;

    if (msg.type === 'signal') {
      const target = this.members(ws).find(({ a }) => a.id === String(msg.to));
      if (target) this.send(target.ws, { type: 'signal', from: me.id, data: msg.data });
    } else if (msg.type === 'meta') {
      if (msg.name) me.name = String(msg.name).trim().slice(0, 32) || me.name;
      me.streams = msg.streams && typeof msg.streams === 'object' ? msg.streams : {};
      ws.serializeAttachment(me);
      for (const { ws: other } of this.members(ws)) {
        this.send(other, { type: 'meta', from: me.id, name: me.name, streams: me.streams });
      }
    }
  }

  leave(ws) {
    let me;
    try { me = ws.deserializeAttachment(); } catch {}
    if (!me || !me.joined) return;
    me.joined = false;
    try { ws.serializeAttachment(me); } catch {}
    for (const { ws: other } of this.members(ws)) this.send(other, { type: 'peer-left', id: me.id });
  }

  async webSocketClose(ws, code) {
    this.leave(ws);
    try { ws.close(code === 1005 ? 1000 : code, 'tchau'); } catch {}
  }

  async webSocketError(ws) {
    this.leave(ws);
  }
}
