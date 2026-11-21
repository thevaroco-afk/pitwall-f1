/**
 * PITWALL — Cronometragem oficial em directo (feed público da F1, sem conta).
 *
 * Um único Durable Object ("LiveTiming") mantém UMA ligação SignalR Core a
 * livetiming.formula1.com/signalrcore enquanto houver alguém na página Ao Vivo,
 * junta as actualizações num estado completo e reenvia-as aos browsers por WebSocket.
 * Sem visitantes durante ~2 minutos, a ligação à F1 é fechada.
 *
 * Só usa os tópicos que a F1 ainda envia sem login (tempos, pneus, bandeiras,
 * direcção de corrida, meteorologia). Posições no mapa e telemetria (Position.z,
 * CarData.z) exigem conta F1 TV e não são pedidas.
 */
import { DurableObject } from 'cloudflare:workers';

const F1 = 'https://livetiming.formula1.com/signalrcore';
const RS = '\x1e'; // separador de mensagens SignalR
const TOPICS = [
  'Heartbeat', 'SessionInfo', 'SessionStatus', 'SessionData', 'TrackStatus', 'LapCount', 'ExtrapolatedClock',
  'DriverList', 'TimingData', 'TimingAppData', 'TimingStats', 'TopThree', 'RaceControlMessages', 'WeatherData',
  'PitLaneTimeCollection', 'TeamRadio',
];
const IDLE_MS = 120_000;   // fecha a ligação à F1 sem visitantes
const TICK_MS = 15_000;    // alarme: ping + vigilância
const FLUSH_MS = 400;      // agrupa actualizações antes de as enviar aos browsers
const UA = 'Mozilla/5.0 (compatible; PITWALL fan site)';

/** Junta uma actualização parcial do feed F1 ao estado (objectos fundidos, arrays por índice). */
export function merge(target, delta) {
  if (delta === null || typeof delta !== 'object' || Array.isArray(delta)) return delta;
  if (target === null || typeof target !== 'object') target = {};
  for (const [k, v] of Object.entries(delta)) {
    if (k === '_deleted') { for (const d of v || []) { if (Array.isArray(target)) target[d] = undefined; else delete target[d]; } continue; }
    if (Array.isArray(v)) target[k] = v;
    else if (v !== null && typeof v === 'object') target[k] = merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

export class LiveTiming extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = {};          // tópico -> estado completo
    this.pending = [];        // [tópico, delta, utc] por enviar
    this.flushTimer = null;
    this.up = null;           // WebSocket para a F1
    this.status = 'idle';     // idle | connecting | connected | error
    this.error = '';
    this.lastMsg = 0;
    this.lastClient = Date.now();
    this.connecting = null;
    this.retry = 0;
    this.base = env.F1_LIVE_URL || F1; // F1_LIVE_URL só para testes locais
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.lastClient = Date.now();
    this.ensureUpstream();
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);

    if (request.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ t: 'snap', state: this.state, status: this.statusInfo() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname.endsWith('/state')) {
      // alternativa sem WebSocket (e útil para verificar se está a funcionar)
      if (this.connecting) await Promise.race([this.connecting, new Promise((r) => setTimeout(r, 4000))]);
      return Response.json({ status: this.statusInfo(), state: this.state }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return new Response('Não encontrado', { status: 404 });
  }

  statusInfo() {
    return { upstream: this.status, error: this.error, lastMsg: this.lastMsg, clients: this.ctx.getWebSockets().length };
  }

  // ---------- Browsers ----------
  webSocketMessage(ws, msg) { if (msg === 'ping') ws.send('{"t":"pong"}'); this.lastClient = Date.now(); }
  webSocketClose(ws) { try { ws.close(); } catch { /* */ } }
  webSocketError(ws) { try { ws.close(); } catch { /* */ } }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch { /* */ } }
  }
  queue(topic, data, utc) {
    this.pending.push([topic, data, utc]);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const d = this.pending; this.pending = [];
      if (d.length) this.broadcast({ t: 'd', d });
    }, FLUSH_MS);
  }
  setStatus(status, error = '') {
    this.status = status; this.error = error;
    this.broadcast({ t: 'status', status: this.statusInfo() });
  }

  // ---------- Ligação à F1 ----------
  ensureUpstream() {
    if (this.up || this.connecting) return;
    this.connecting = this.connect().catch((e) => {
      this.up = null;
      this.retry++;
      this.setStatus('error', String(e.message || e));
    }).finally(() => { this.connecting = null; });
  }

  async connect() {
    this.setStatus('connecting');
    const neg = await fetch(`${this.base}/negotiate?negotiateVersion=1`, { method: 'POST', headers: { 'User-Agent': UA } });
    if (!neg.ok) throw new Error(`negotiate HTTP ${neg.status}`);
    const info = await neg.json();
    const id = info.connectionToken || info.connectionId;
    if (!id) throw new Error('negotiate sem connectionToken');
    // cookies de balanceamento (ex.: AWSALBCORS) têm de seguir para o WebSocket
    const cookies = (neg.headers.getSetCookie?.() || [neg.headers.get('set-cookie')].filter(Boolean))
      .map((c) => c.split(';')[0]).join('; ');
    const headers = { Upgrade: 'websocket', 'User-Agent': UA };
    if (cookies) headers.Cookie = cookies;
    const res = await fetch(`${this.base}?id=${encodeURIComponent(id)}`, { headers });
    const ws = res.webSocket;
    if (!ws) throw new Error(`websocket HTTP ${res.status}`);
    ws.accept();
    this.up = ws;
    let buf = '';
    ws.addEventListener('message', (ev) => {
      buf += typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
      const parts = buf.split(RS);
      buf = parts.pop();
      for (const p of parts) if (p) this.onFrame(p);
    });
    const gone = (why) => { if (this.up === ws) { this.up = null; this.setStatus('error', why); } };
    ws.addEventListener('close', (ev) => gone(`ligação fechada (${ev.code})`));
    ws.addEventListener('error', () => gone('erro na ligação'));
    ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
    ws.send(JSON.stringify({ type: 1, target: 'Subscribe', arguments: [TOPICS], invocationId: '1' }) + RS);
    this.retry = 0;
    this.setStatus('connected');
  }

  onFrame(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    this.lastMsg = Date.now();
    if (m.type === 1 && m.target === 'feed') {
      const [topic, data, utc] = m.arguments || [];
      if (!topic) return;
      this.state[topic] = merge(this.state[topic], data);
      this.queue(topic, data, utc);
    } else if (m.type === 3 && m.result && typeof m.result === 'object') {
      // resposta ao Subscribe: estado inicial completo de cada tópico
      for (const [topic, data] of Object.entries(m.result)) this.state[topic] = data;
      this.broadcast({ t: 'snap', state: this.state, status: this.statusInfo() });
    } else if (m.type === 3 && m.error) {
      this.setStatus('error', 'Subscribe: ' + m.error);
    } else if (m.type === 7) {
      try { this.up?.close(); } catch { /* */ }
      this.up = null;
      this.setStatus('error', 'F1 fechou a ligação' + (m.error ? ': ' + m.error : ''));
    }
  }

  async alarm() {
    const clients = this.ctx.getWebSockets().length;
    if (clients) this.lastClient = Date.now();
    if (Date.now() - this.lastClient > IDLE_MS) {
      try { this.up?.close(1000, 'sem visitantes'); } catch { /* */ }
      this.up = null;
      this.status = 'idle';
      return; // sem novo alarme: o objecto pode adormecer
    }
    if (this.up) {
      try { this.up.send('{"type":6}' + RS); } catch { this.up = null; }
      // sem mensagens há muito tempo → religar
      if (this.lastMsg && Date.now() - this.lastMsg > 90_000) { try { this.up?.close(); } catch { /* */ } this.up = null; }
    }
    if (!this.up && !this.connecting && this.retry < 20) this.ensureUpstream();
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }
}
