// =========================================================
// AO VIVO / REPLAY — OpenF1
// =========================================================
import { init, $, $$, esc, getJSON, smartFetch, parseT, currentLiveSession, fmt, flagCountry, flagTextCountry, skeleton, errorBox, qs, setQs, clamp, sleep } from './core.js';
import { CONFIG } from './config.js';
import { mountOfficialLive } from './officiallive.js';
import { strategyChart, lapTimeChart, positionChart, driverMapFromOpenF1, TYRE_COLORS, tyreLetter } from './raceviz.js';

const API = CONFIG.openf1;
const WIN = 60_000;          // janelas de localização de 60 s
const LIVE_DELAY = 8_000;    // atraso em directo (latência dos dados)
const ROW_H = 35;

const S = {
  session: null, meeting: null, drivers: new Map(), outline: null, bounds: null,
  tStart: 0, tEnd: 0, T: 0, playing: false, speed: 1, live: false, followLive: false,
  windows: new Map(), loading: new Set(),
  pos: new Map(), ints: new Map(), laps: new Map(), stints: [], pits: [], rc: [], weather: [], radio: [],
  selected: null, car: new Map(), carLoading: new Set(),
  lastTower: 0, lastRCCount: -1, isRace: false, token: 0,
};

const iso = (ms) => new Date(ms).toISOString().slice(0, 23);
const q = (path, params) => `${API}/${path}?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;

async function raw(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await smartFetch(url);
      if (r.status === 404) return [];
      if (r.status === 401 || r.status === 403) { const e = new Error('auth'); e.auth = true; throw e; }
      if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    } catch (e) { if (e.auth || i === 2) throw e; await sleep(600 * (i + 1)); }
  }
  return [];
}

function bisectT(arr, t) { // último índice com arr[i].t <= t
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function groupBy(rows, key = 'driver_number', tKey = 'date') {
  const m = new Map();
  for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push({ ...r, t: parseT(r[tKey]) }); }
  for (const a of m.values()) a.sort((x, y) => x.t - y.t);
  return m;
}
function mergeGrouped(target, rows, key = 'driver_number', tKey = 'date') {
  const g = groupBy(rows, key, tKey);
  for (const [k, arr] of g) {
    const cur = target.get(k) || [];
    const lastT = cur.length ? cur[cur.length - 1].t : -Infinity;
    for (const r of arr) if (r.t > lastT) cur.push(r);
    target.set(k, cur);
  }
}

// ---------- Selecção de sessão ----------
async function loadSessionList(year) {
  const [sessions, meetings] = await Promise.all([
    getJSON(q('sessions', { year }), { ttl: 1800 }),
    getJSON(q('meetings', { year }), { ttl: 3600 }).catch(() => []),
  ]);
  const mName = new Map(meetings.map((m) => [m.meeting_key, m]));
  const now = Date.now();
  const byMeeting = new Map();
  for (const s of sessions.filter((s) => parseT(s.date_start) < now + 3600e3).sort((a, b) => parseT(a.date_start) - parseT(b.date_start))) {
    if (!byMeeting.has(s.meeting_key)) byMeeting.set(s.meeting_key, { meeting: mName.get(s.meeting_key) || { meeting_name: `${s.country_name} — ${s.circuit_short_name}`, country_name: s.country_name }, sessions: [] });
    byMeeting.get(s.meeting_key).sessions.push(s);
  }
  return [...byMeeting.entries()].filter(([, v]) => !/test/i.test(v.meeting.meeting_name || ''));
}
const SESSION_PT = { 'Practice 1': 'Treinos Livres 1', 'Practice 2': 'Treinos Livres 2', 'Practice 3': 'Treinos Livres 3', Qualifying: 'Qualificação', 'Sprint Qualifying': 'Qualificação Sprint', 'Sprint Shootout': 'Sprint Shootout', Sprint: 'Sprint', Race: 'Corrida' };
const ptName = (n) => SESSION_PT[n] || n;

// ---------- Carregar sessão ----------
async function loadSession(session, meeting) {
  const token = ++S.token;
  Object.assign(S, {
    session, meeting, outline: null, bounds: null, windows: new Map(), loading: new Set(), pos: new Map(), ints: new Map(), laps: new Map(),
    stints: [], pits: [], rc: [], weather: [], radio: [], selected: null, car: new Map(), carLoading: new Set(), lastRCCount: -1, playing: false,
  });
  S.isRace = /race|sprint$/i.test(session.session_type || session.session_name) && !/qual|shootout/i.test(session.session_name);
  const now = Date.now();
  S.tStart = parseT(session.date_start) - 5 * 60e3;
  S.tEnd = Math.min(parseT(session.date_end) + 10 * 60e3, now);
  S.live = now >= parseT(session.date_start) - 15 * 60e3 && now <= parseT(session.date_end) + 30 * 60e3;
  S.followLive = S.live;
  setQs({ s: session.session_key, d: null });
  // Em directo a OpenF1 exige conta paga e o mapa/telemetria da F1 exigem F1 TV:
  // mostra-se só a cronometragem oficial (quadro acima) e o replay fica para depois.
  if (S.live) { S.live = false; S.followLive = false; setOpenF1(false); return; }
  setOpenF1(true);
  $('#sessTitle').innerHTML = `${flagCountry(session.country_name)} ${esc(meeting?.meeting_name || session.country_name)} <span class="muted" style="font-weight:600">· ${esc(ptName(session.session_name))} ${session.year}</span>`;
  $('#liveChip').innerHTML = S.live ? '<span class="chip live">AO VIVO</span>' : '<span class="chip">REPLAY</span>';
  $('#tower').innerHTML = skeleton(12);
  $('#status').textContent = 'A carregar pilotos e dados da sessão…';

  const K = session.session_key;
  let drivers;
  try { drivers = await raw(q('drivers', { session_key: K })); }
  catch (e) { return showAuthOrError(e); }
  if (token !== S.token) return;
  S.drivers = driverMapFromOpenF1(drivers);
  if (!S.drivers.size) { $('#status').innerHTML = ''; $('#tower').innerHTML = errorBox('Ainda não há dados para esta sessão.', S.live ? 'Em directo, a OpenF1 gratuita só disponibiliza os dados depois da sessão terminar. Escolha uma sessão anterior acima para ver o replay.' : 'Escolha outra sessão acima.'); return; }

  const eps = [['position', 'pos'], ['laps', 'laps'], ['stints', null], ['pit', null], ['race_control', null], ['weather', null], ['team_radio', null]];
  if (S.isRace) eps.push(['intervals', 'ints']);
  const res = await Promise.allSettled(eps.map(([ep]) => raw(q(ep, { session_key: K }))));
  if (token !== S.token) return;
  res.forEach((r, i) => {
    const [ep] = eps[i];
    const rows = r.status === 'fulfilled' ? r.value : [];
    if (ep === 'position') S.pos = groupBy(rows);
    else if (ep === 'intervals') S.ints = groupBy(rows);
    else if (ep === 'laps') S.laps = groupBy(rows.map((l) => ({ ...l, date: l.date_start || null })).filter((l) => l.date), 'driver_number', 'date');
    else if (ep === 'stints') S.stints = rows;
    else if (ep === 'pit') S.pits = rows.map((p) => ({ ...p, t: parseT(p.date) }));
    else if (ep === 'race_control') S.rc = rows.map((p) => ({ ...p, t: parseT(p.date) })).sort((a, b) => a.t - b.t);
    else if (ep === 'weather') S.weather = rows.map((p) => ({ ...p, t: parseT(p.date) })).sort((a, b) => a.t - b.t);
    else if (ep === 'team_radio') S.radio = rows.map((p) => ({ ...p, t: parseT(p.date) })).sort((a, b) => a.t - b.t);
  });
  const lastData = Math.max(...[...S.pos.values()].map((a) => a.at(-1)?.t || 0), ...S.rc.map((r) => r.t), 0);
  if (!S.live && lastData) S.tEnd = Math.min(S.tEnd, lastData + 3 * 60e3);

  // ponto de partida: em corrida, perto do arranque
  S.T = S.tStart + 5 * 60e3;
  if (S.isRace) {
    const lap2 = [...S.laps.values()].map((a) => a.find((l) => l.lap_number === 2)?.t).filter(Boolean);
    const lapDurs = [...S.laps.values()].flat().map((l) => l.lap_duration).filter(Boolean).sort((a, b) => a - b);
    if (lap2.length && lapDurs.length) S.T = Math.min(...lap2) - lapDurs[Math.floor(lapDurs.length / 2)] * 1000 * 1.15 - 20_000;
  }
  if (S.followLive) S.T = Date.now() - LIVE_DELAY;
  S.T = clamp(S.T, S.tStart, S.tEnd);

  $('#status').textContent = 'A desenhar o circuito…';
  await loadOutline(K, token);
  if (token !== S.token) return;
  $('#status').textContent = '';
  setupScrubber();
  fillJumps();
  renderAnalysis();
  await ensureWindows();
  updateTower(true);
}

function setOpenF1(show) {
  $('#of1Wrap')?.classList.toggle('hidden', !show);
  const note = $('#of1Note');
  if (note) note.innerHTML = show ? '' : `<div class="notice" style="margin-top:4px">Esta sessão está a decorrer. Em directo mostramos a <b>cronometragem oficial</b> acima. O mapa da pista, a telemetria e a análise desta sessão ficam disponíveis aqui em replay pouco depois de terminar. Pode escolher outra sessão nos menus acima.</div>`;
  if (!show) $('#status').textContent = '';
}

function showAuthOrError(e) {
  $('#status').textContent = '';
  if (e.auth) { setOpenF1(false); return; }
  $('#tower').innerHTML = e.auth
    ? `<div class="notice warn" style="margin:14px">A OpenF1 só disponibiliza dados <b>em tempo real</b> a contas pagas. Veja a tabela de tempos em directo no quadro <b>Cronometragem oficial F1</b> acima; o mapa e o replay completo ficam disponíveis pouco depois de a sessão terminar.</div>`
    : errorBox('Não foi possível ligar à OpenF1.', e.message);
}

async function loadOutline(K, token) {
  // Volta mais rápida de qualquer piloto = traçado limpo do circuito
  const all = [...S.laps.values()].flat().filter((l) => l.lap_duration && l.t && !l.is_pit_out_lap).sort((a, b) => a.lap_duration - b.lap_duration);
  let pts = [];
  for (const lap of all.slice(0, 3)) {
    try {
      pts = await raw(q('location', { session_key: K, driver_number: lap.driver_number, 'date>': iso(lap.t), 'date<': iso(lap.t + lap.lap_duration * 1000 + 500) }));
    } catch { pts = []; }
    pts = pts.filter((p) => p.x || p.y);
    if (pts.length > 40) break;
  }
  if (pts.length < 40) {
    // sem voltas: usar 2 minutos de um piloto em pista
    const first = [...S.drivers.keys()][0];
    try {
      const t0 = Math.max(S.tStart + 20 * 60e3, S.T);
      pts = (await raw(q('location', { session_key: K, driver_number: first, 'date>': iso(t0), 'date<': iso(t0 + 150_000) }))).filter((p) => p.x || p.y);
    } catch { pts = []; }
  }
  if (token !== S.token) return;
  S.outline = pts.map((p) => [p.x, p.y]);
  computeBounds(S.outline);
}
function computeBounds(points) {
  if (!points.length) { S.bounds = null; return; }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  S.bounds = { x0, x1, y0, y1 };
}

// ---------- Janelas de localização ----------
function winIdx(t) { return Math.floor((t - S.tStart) / WIN); }
async function loadWindow(w, token) {
  if (S.loading.has(w)) return;
  const existing = S.windows.get(w);
  if (existing?.complete) return;
  S.loading.add(w);
  const from = S.tStart + w * WIN, to = from + WIN;
  const since = existing?.lastT ? existing.lastT : from;
  try {
    const rows = await raw(q('location', { session_key: S.session.session_key, 'date>': iso(since), 'date<': iso(to) }));
    if (token !== S.token) return;
    const win = existing || { byD: new Map(), lastT: from, complete: false };
    for (const r of rows) {
      if (!r.x && !r.y) continue;
      const t = parseT(r.date);
      if (!win.byD.has(r.driver_number)) win.byD.set(r.driver_number, []);
      win.byD.get(r.driver_number).push({ t, x: r.x, y: r.y });
      if (t > win.lastT) win.lastT = t;
    }
    for (const a of win.byD.values()) a.sort((a1, b1) => a1.t - b1.t);
    win.complete = to < Date.now() - 30_000;
    S.windows.set(w, win);
    // libertar memória de janelas antigas
    for (const k of S.windows.keys()) if (Math.abs(k - w) > 12) S.windows.delete(k);
  } catch (e) {
    if (e.auth) { S.playing = false; showAuthOrError(e); }
  } finally { S.loading.delete(w); }
}
async function ensureWindows() {
  const token = S.token;
  const w = winIdx(S.T);
  const ahead = S.playing ? Math.ceil((S.speed * 25_000) / WIN) + 1 : 1;
  const jobs = [];
  for (let i = -1; i <= ahead; i++) {
    const k = w + i;
    if (k < 0 || S.tStart + k * WIN > S.tEnd + WIN) continue;
    const win = S.windows.get(k);
    const isLiveEdge = S.followLive && S.tStart + (k + 1) * WIN > Date.now() - 60_000;
    if (!win || (!win.complete && (isLiveEdge || !win.lastT))) jobs.push(k);
  }
  for (const k of jobs.slice(0, 3)) await loadWindow(k, token);
}

function carPos(num, t) {
  const w = winIdx(t);
  let a = null, b = null;
  for (const k of [w - 1, w, w + 1]) {
    const arr = S.windows.get(k)?.byD.get(num);
    if (!arr?.length) continue;
    const i = bisectT(arr, t);
    if (i >= 0 && (!a || arr[i].t > a.t)) a = arr[i];
    if (i + 1 < arr.length && (!b || arr[i + 1].t < b.t)) b = arr[i + 1];
  }
  if (!a) return null;
  if (t - a.t > 6000) return null; // dados velhos: carro provavelmente nas boxes / sem sinal
  if (!b || b.t - a.t > 3000) return { x: a.x, y: a.y };
  const f = (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// ---------- Estado no instante T ----------
function at(map, num, t) { const arr = map.get(num); if (!arr) return null; const i = bisectT(arr, t); return i >= 0 ? arr[i] : null; }
function lapInfo(num, t) {
  const arr = S.laps.get(num) || [];
  const i = bisectT(arr, t);
  const cur = i >= 0 ? arr[i] : null;
  let last = null, best = null;
  for (let j = 0; j <= i; j++) {
    const l = arr[j];
    if (!l.lap_duration) continue;
    if (l.t + l.lap_duration * 1000 > t) continue;
    last = l;
    if (!best || l.lap_duration < best.lap_duration) best = l;
  }
  return { lap: cur?.lap_number || (arr.length && arr[0].t > t ? 0 : null), cur, last, best };
}
function tyreAt(num, lap) {
  const st = S.stints.filter((s) => s.driver_number === num).sort((a, b) => a.stint_number - b.stint_number);
  if (!st.length) return null;
  let s = st.find((x) => lap >= (x.lap_start || 0) && lap <= (x.lap_end || 999)) || st[0];
  if (lap > (st.at(-1).lap_end || 999)) s = st.at(-1);
  return { compound: s.compound || 'UNKNOWN', age: (s.tyre_age_at_start || 0) + Math.max(0, (lap || 1) - (s.lap_start || 1)) };
}
function trackStatus(t) {
  let st = { k: 'GREEN', label: 'Pista livre' };
  for (const m of S.rc) {
    if (m.t > t) break;
    const msg = (m.message || '').toUpperCase();
    if (m.category === 'SafetyCar' || msg.includes('SAFETY CAR')) {
      if (msg.includes('VIRTUAL') && msg.includes('DEPLOYED')) st = { k: 'VSC', label: 'Virtual Safety Car' };
      else if (msg.includes('DEPLOYED')) st = { k: 'SC', label: 'Safety Car' };
      else if (msg.includes('ENDING') || msg.includes('IN THIS LAP')) st = { ...st, label: st.label + ' · a terminar' };
    } else if (m.flag === 'RED') st = { k: 'RED', label: 'Bandeira vermelha' };
    else if (m.flag === 'CHEQUERED') st = { k: 'CHEQUERED', label: 'Bandeira axadrezada' };
    else if ((m.flag === 'GREEN' || m.flag === 'CLEAR') && m.scope === 'Track') st = { k: 'GREEN', label: 'Pista livre' };
  }
  return st;
}

// ---------- Desenho do mapa ----------
let canvas, ctx, view = null;
function setupCanvas() {
  canvas = $('#track'); ctx = canvas.getContext('2d');
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view = null;
  };
  new ResizeObserver(resize).observe(canvas);
  resize();
  canvas.addEventListener('click', (e) => {
    if (!view) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let bestD = 22, sel = null;
    for (const num of S.drivers.keys()) {
      const p = carPos(num, S.T); if (!p) continue;
      const [sx, sy] = view.tr(p.x, p.y);
      const d = Math.hypot(sx - mx, sy - my);
      if (d < bestD) { bestD = d; sel = num; }
    }
    selectDriver(sel === S.selected ? null : sel);
  });
}
function makeView() {
  const W = canvas.clientWidth, H = canvas.clientHeight, b = S.bounds;
  if (!b || !W) return null;
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const rotate = bh > bw * 1.15 && W > H; // circuitos "altos" rodados 90°
  const w = rotate ? bh : bw, h = rotate ? bw : bh;
  const pad = 34;
  const sc = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
  const ox = (W - w * sc) / 2, oy = (H - h * sc) / 2;
  const tr = (x, y) => {
    let u = x - b.x0, v = y - b.y0;
    if (rotate) [u, v] = [v, bw - u];
    return [ox + u * sc, H - (oy + v * sc)];
  };
  return { tr, W, H };
}
function drawTrack() {
  if (!ctx) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  if (!S.bounds) return;
  if (!view) view = makeView();
  if (!view) return;
  const { tr } = view;
  // traçado
  if (S.outline?.length) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const path = new Path2D();
    S.outline.forEach(([x, y], i) => { const [sx, sy] = tr(x, y); i ? path.lineTo(sx, sy) : path.moveTo(sx, sy); });
    ctx.strokeStyle = '#000'; ctx.lineWidth = 16; ctx.stroke(path);
    ctx.strokeStyle = '#2e2e3c'; ctx.lineWidth = 11; ctx.stroke(path);
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.setLineDash([4, 6]); ctx.stroke(path); ctx.setLineDash([]);
    const [sx, sy] = tr(...S.outline[0]);
    ctx.fillStyle = '#fff'; ctx.fillRect(sx - 2, sy - 9, 4, 18);
  }
  // carros (por ordem inversa da posição para o líder ficar por cima)
  const order = towerOrder(S.T).reverse();
  for (const num of order) {
    const p = carPos(num, S.T); if (!p) continue;
    const d = S.drivers.get(num);
    const [sx, sy] = tr(p.x, p.y);
    const sel = num === S.selected;
    const dim = S.selected && !sel;
    ctx.globalAlpha = dim ? .45 : 1;
    ctx.beginPath(); ctx.arc(sx, sy, sel ? 9 : 6.5, 0, Math.PI * 2);
    ctx.fillStyle = d.color; ctx.fill();
    ctx.lineWidth = sel ? 3 : 1.6; ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,.8)'; ctx.stroke();
    ctx.font = `800 ${sel ? 13 : 11}px "Titillium Web", sans-serif`;
    const label = d.acr;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(8,8,12,.82)';
    ctx.fillRect(sx + 9, sy - 8, tw + 8, 16);
    ctx.fillStyle = sel ? '#fff' : '#e8e8f0';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(label, sx + 13, sy);
    ctx.globalAlpha = 1;
  }
}

// ---------- Torre de tempos ----------
function towerOrder(t) {
  const nums = [...S.drivers.keys()];
  const p = new Map(nums.map((n) => [n, at(S.pos, n, t)?.position ?? 99]));
  return nums.sort((a, b) => p.get(a) - p.get(b));
}
const prevPos = new Map();
function updateTower(force = false) {
  const now = performance.now();
  if (!force && now - S.lastTower < 250) return;
  S.lastTower = now;
  const t = S.T;
  const order = towerOrder(t);
  const el = $('#towerRows');
  if (!el) return;
  if (el.dataset.session !== String(S.session.session_key)) {
    el.dataset.session = S.session.session_key;
    el.style.height = order.length * ROW_H + 'px';
    el.innerHTML = order.map((n) => { const d = S.drivers.get(n); return `<div class="row" data-n="${n}" style="position:absolute;left:0;right:0;transition:transform .6s cubic-bezier(.2,.8,.2,1)"><span class="p"></span><span class="team-bar" style="background:${d.color};height:20px"></span><span class="ab">${esc(d.acr)}</span><span class="gp"></span><span class="gap"></span><span class="ty"></span></div>`; }).join('');
    $('#tower').innerHTML = '';
    el.onclick = (e) => { const r = e.target.closest('.row'); if (r) selectDriver(+r.dataset.n === S.selected ? null : +r.dataset.n); };
  }
  // melhor volta global até T (roxo)
  let overallBest = Infinity;
  const info = new Map();
  for (const n of order) { const li = lapInfo(n, t); info.set(n, li); if (li.best && li.best.lap_duration < overallBest) overallBest = li.best.lap_duration; }
  let leaderLap = 0;
  order.forEach((n, i) => {
    const row = el.querySelector(`.row[data-n="${n}"]`);
    if (!row) return;
    const posRec = at(S.pos, n, t);
    const P = posRec?.position;
    const li = info.get(n);
    if (i === 0 && li.lap) leaderLap = li.lap;
    row.style.transform = `translateY(${i * ROW_H}px)`;
    row.classList.toggle('sel', n === S.selected);
    const pp = prevPos.get(n);
    if (pp && P && pp !== P) { row.classList.remove('up', 'down'); void row.offsetWidth; row.classList.add(P < pp ? 'up' : 'down'); }
    if (P) prevPos.set(n, P);
    row.querySelector('.p').textContent = P ?? '';
    const gapEl = row.querySelector('.gp'), lastEl = row.querySelector('.gap');
    const pitting = S.pits.some((p) => p.driver_number === n && p.t <= t && p.t + (p.pit_duration || 25) * 1000 >= t);
    if (S.isRace) {
      const iv = at(S.ints, n, t);
      const g = iv?.gap_to_leader, it = iv?.interval;
      const gs = i === 0 ? (li.lap ? `Volta ${li.lap}` : 'Líder') : g == null ? '' : typeof g === 'string' ? g : `+${g.toFixed(3)}`;
      const is = i === 0 ? '' : it == null ? '' : typeof it === 'string' ? it : `+${it.toFixed(3)}`;
      gapEl.innerHTML = pitting ? '<span class="chip yellow" style="padding:1px 7px">BOX</span>' : `${esc(is || gs)}${is && gs && i > 1 ? `<small>${esc(gs)}</small>` : ''}`;
    } else {
      const bestTop = info.get(order[0])?.best?.lap_duration;
      const b = li.best?.lap_duration;
      gapEl.innerHTML = pitting ? '<span class="chip yellow" style="padding:1px 7px">BOX</span>' : b ? `${fmt.lap(b)}${i > 0 && bestTop ? `<small>+${(b - bestTop).toFixed(3)}</small>` : ''}` : '<span class="muted">—</span>';
    }
    const lt = li.last?.lap_duration;
    lastEl.innerHTML = lt ? `<span style="color:${lt === overallBest ? 'var(--purple)' : li.best && lt === li.best.lap_duration ? 'var(--green)' : 'inherit'}">${fmt.lap(lt)}</span>` : '';
    const ty = tyreAt(n, li.lap || 1);
    row.querySelector('.ty').innerHTML = ty ? `<span class="tyre ${ty.compound}" title="${ty.compound} · ${ty.age} voltas">${tyreLetter(ty.compound)}</span>` : '';
  });
  // cabeçalho do mapa
  const st = trackStatus(t);
  $('#flag').className = `flag-banner flag-${st.k}`;
  $('#flag').textContent = st.label;
  $('#lapNo').textContent = S.isRace && leaderLap ? `VOLTA ${leaderLap}` : ptName(S.session.session_name).toUpperCase();
  updateFeeds(t);
  updateDriverPanel(t);
}

// ---------- Direcção de corrida, meteo, rádio ----------
function updateFeeds(t) {
  const msgs = S.rc.filter((m) => m.t <= t);
  if (msgs.length !== S.lastRCCount) {
    const isNew = S.lastRCCount >= 0 && msgs.length > S.lastRCCount;
    S.lastRCCount = msgs.length;
    $('#rc').innerHTML = msgs.slice(-40).reverse().map((m, i) => {
      const color = m.flag === 'RED' ? 'var(--red)' : /YELLOW/.test(m.flag || '') ? 'var(--yellow)' : m.flag === 'GREEN' || m.flag === 'CLEAR' ? 'var(--green)' : m.category === 'SafetyCar' ? 'var(--orange)' : m.flag === 'BLUE' ? 'var(--blue)' : 'var(--text-2)';
      return `<div class="it ${isNew && i === 0 ? 'new' : ''}"><span class="tm">${fmt.clock(m.t).slice(0, 8)}${m.lap_number ? `<br>V${m.lap_number}` : ''}</span><span style="border-left:3px solid ${color};padding-left:9px">${esc(m.message)}</span></div>`;
    }).join('') || '<p class="muted" style="padding:10px 0">Sem mensagens até este momento.</p>';
    const radios = S.radio.filter((r) => r.t <= t).slice(-12).reverse();
    $('#radio').innerHTML = radios.map((r) => { const d = S.drivers.get(r.driver_number); return `<div class="it"><span class="mono" style="min-width:60px;font-size:12.5px;color:var(--muted)">${fmt.clock(r.t).slice(0, 5)}</span><b style="min-width:42px;border-left:3px solid ${d?.color || '#888'};padding-left:6px">${esc(d?.acr || r.driver_number)}</b><audio controls preload="none" src="${esc(r.recording_url)}"></audio></div>`; }).join('') || '<p class="muted" style="padding:10px 0">Sem rádio até este momento.</p>';
  }
  const i = bisectT(S.weather, t);
  const w = i >= 0 ? S.weather[i] : S.weather[0];
  $('#weather').innerHTML = w ? [
    [`${fmt.num(w.air_temperature, 1)}°`, 'Ar'], [`${fmt.num(w.track_temperature, 1)}°`, 'Pista'], [`${fmt.num(w.humidity)}%`, 'Humidade'],
    [`${fmt.num(w.wind_speed, 1)} m/s`, 'Vento'], [`${['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round((w.wind_direction || 0) / 45) % 8]}`, 'Direcção'], [w.rainfall ? '🌧 Sim' : '☀ Não', 'Chuva'],
  ].map(([v, l]) => `<div class="w"><b>${v}</b><span>${l}</span></div>`).join('') : '<p class="muted">Sem dados meteorológicos.</p>';
}

// ---------- Painel do piloto seleccionado ----------
function selectDriver(n) {
  S.selected = n;
  $('#drvPanel').classList.toggle('hidden', !n);
  if (n) loadCar(n, S.T);
  updateTower(true);
  drawTrack();
}
async function loadCar(n, t) {
  const w = winIdx(t);
  const key = `${n}:${w}`;
  if (S.car.has(key) || S.carLoading.has(key)) return;
  S.carLoading.add(key);
  const from = S.tStart + w * WIN;
  try {
    const rows = await raw(q('car_data', { session_key: S.session.session_key, driver_number: n, 'date>': iso(from), 'date<': iso(from + WIN) }));
    S.car.set(key, rows.map((r) => ({ ...r, t: parseT(r.date) })).sort((a, b) => a.t - b.t));
    if (S.car.size > 40) S.car.delete(S.car.keys().next().value);
  } catch { /* */ } finally { S.carLoading.delete(key); }
}
const SEG = { 2048: 'var(--yellow)', 2049: 'var(--green)', 2051: 'var(--purple)', 2064: 'var(--blue)', 0: 'var(--surface-3)' };
function updateDriverPanel(t) {
  const n = S.selected;
  if (!n) return;
  const d = S.drivers.get(n);
  const w = winIdx(t);
  loadCar(n, t);
  if (t - (S.tStart + w * WIN) > WIN * 0.7) loadCar(n, t + WIN);
  const arr = S.car.get(`${n}:${w}`) || [];
  const i = bisectT(arr, t);
  const c = i >= 0 ? arr[i] : null;
  const li = lapInfo(n, t);
  const ty = tyreAt(n, li.lap || 1);
  const pits = S.pits.filter((p) => p.driver_number === n && p.t <= t).length;
  const segs = (l) => l ? [1, 2, 3].map((s) => `<div style="flex:1"><div class="muted" style="font-size:11px;font-weight:700">S${s} <span class="mono" style="color:var(--text)">${l['duration_sector_' + s] ? l['duration_sector_' + s].toFixed(3) : '—'}</span></div><div style="display:flex;gap:2px;margin-top:3px">${(l['segments_sector_' + s] || []).map((v) => `<i style="flex:1;height:6px;border-radius:2px;background:${SEG[v] || 'var(--surface-3)'}"></i>`).join('')}</div></div>`).join('') : '';
  const gauge = (label, v, max, col, unit = '') => `<div><div class="row-flex" style="justify-content:space-between;font-size:12px"><span class="muted" style="font-weight:700;text-transform:uppercase;letter-spacing:.06em">${label}</span><b class="mono">${v ?? '—'}${unit}</b></div><div style="height:6px;background:var(--surface-3);border-radius:4px;overflow:hidden;margin-top:3px"><i style="display:block;height:100%;width:${clamp(((v || 0) / max) * 100, 0, 100)}%;background:${col};transition:width .15s"></i></div></div>`;
  $('#drvPanel').innerHTML = `
    <div class="row-flex" style="gap:14px">
      ${d.headshot ? `<img src="${esc(d.headshot)}" alt="" style="width:62px;height:62px;border-radius:12px;background:var(--surface-3);object-fit:cover">` : ''}
      <div style="flex:1;min-width:0"><div style="font-weight:900;font-size:20px;line-height:1.1">${esc(d.name || d.acr)}</div><div class="muted" style="font-size:13.5px"><span style="color:${d.color}">■</span> ${esc(d.team || '')} · #${n}</div></div>
      <button class="btn small" id="closeDrv">✕</button>
    </div>
    <div class="grid g-2 mt" style="gap:12px">
      <div class="stat"><span class="v" style="font-size:40px">${c?.speed ?? '—'}<small class="muted" style="font-size:14px"> km/h</small></span><span class="l">Velocidade</span></div>
      <div class="stat"><span class="v" style="font-size:40px">${c ? (c.n_gear || 'N') : '—'}</span><span class="l">Mudança ${c && c.drs >= 10 ? '<span class="chip green">DRS</span>' : ''}</span></div>
    </div>
    <div class="grid mt-s" style="gap:8px">${gauge('Acelerador', c?.throttle, 100, 'var(--green)', '%')}${gauge('Travão', c ? (c.brake > 0 ? 100 : 0) : null, 100, 'var(--red)', c?.brake > 0 ? '' : '')}${gauge('RPM', c?.rpm, 13000, 'var(--blue)')}</div>
    <div class="row-flex mt" style="font-size:14px;gap:16px"><span>Volta <b class="mono">${li.lap ?? '—'}</b></span><span>Melhor <b class="mono">${fmt.lap(li.best?.lap_duration)}</b></span><span>Pneu ${ty ? `<span class="tyre ${ty.compound}" style="vertical-align:middle">${tyreLetter(ty.compound)}</span> <b class="mono">${ty.age}v</b>` : '—'}</span><span>Paragens <b class="mono">${pits}</b></span></div>
    ${li.last ? `<div class="mt-s"><div class="muted" style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Última volta · ${fmt.lap(li.last.lap_duration)} ${li.last.st_speed ? `· speed trap ${li.last.st_speed} km/h` : ''}</div><div style="display:flex;gap:10px">${segs(li.last)}</div></div>` : ''}`;
  $('#closeDrv').onclick = () => selectDriver(null);
}

// ---------- Leitor / scrubber ----------
// Momentos-chave para sincronizar com o vídeo (diferido)
function fillJumps() {
  const sel = $('#jumpSel'); if (!sel) return;
  const opts = [];
  let part = 0;
  const isQ = /qual|shootout/i.test(S.session?.session_name || '');
  for (const m of S.rc) {
    const msg = (m.message || '').toUpperCase();
    let label = null;
    if (/GREEN LIGHT|PIT EXIT OPEN/.test(msg)) { part++; label = isQ ? `Luz verde Q${part}` : S.isRace ? 'Saída das boxes aberta' : 'Luz verde'; }
    else if (m.flag === 'RED') label = 'Bandeira vermelha';
    else if (m.flag === 'CHEQUERED') label = 'Bandeira axadrezada';
    else if (/SAFETY CAR DEPLOYED/.test(msg)) label = /VIRTUAL/.test(msg) ? 'VSC' : 'Safety Car';
    else if (/RESUME|RESTART/.test(msg)) label = 'Recomeço';
    if (label) opts.push({ t: m.t, label: `${fmt.clock(m.t).slice(0, 8)} · ${label}` });
  }
  if (S.isRace) {
    const lap1 = [...S.laps.values()].map((a) => a.find((l) => l.lap_number === 1)?.t).filter(Boolean);
    if (lap1.length) opts.push({ t: Math.min(...lap1), label: `${fmt.clock(Math.min(...lap1)).slice(0, 8)} · Partida (volta 1)` });
  }
  opts.sort((a, b) => a.t - b.t);
  sel.innerHTML = '<option value="">Saltar para…</option>' + opts.map((o) => `<option value="${o.t}">${esc(o.label)}</option>`).join('');
}

function setupScrubber() {
  const r = $('#scrub');
  r.min = 0; r.max = Math.round((S.tEnd - S.tStart) / 1000); r.value = Math.round((S.T - S.tStart) / 1000);
  $('#liveBtn').classList.toggle('hidden', !S.live);
  updatePlayer();
}
function updatePlayer() {
  $('#scrub').value = Math.round((S.T - S.tStart) / 1000);
  $('#clock').textContent = fmt.clock(S.T);
  $('#playBtn').innerHTML = S.playing ? '❚❚' : '▶';
  $('#liveBtn').classList.toggle('primary', S.followLive);
}
let lastFrame = 0, lastEnsure = 0;
function loop(ts) {
  const dt = lastFrame ? Math.min(ts - lastFrame, 250) : 0;
  lastFrame = ts;
  if (S.session) {
    if (S.followLive) {
      S.T = Date.now() - LIVE_DELAY;
      S.tEnd = Math.max(S.tEnd, Date.now());
      $('#scrub').max = Math.round((S.tEnd - S.tStart) / 1000);
    } else if (S.playing) {
      S.T += dt * S.speed;
      if (S.T >= S.tEnd) { S.T = S.tEnd; S.playing = false; }
    }
    if (ts - lastEnsure > 700) { lastEnsure = ts; ensureWindows(); }
    drawTrack();
    updateTower();
    if (S.playing || S.followLive) updatePlayer();
  }
  requestAnimationFrame(loop);
}

// Em directo: actualizar endpoints incrementais
async function livePoll() {
  while (true) {
    await sleep(6000);
    if (!S.session || !S.live) continue;
    const K = S.session.session_key;
    const token = S.token;
    const since = iso(Date.now() - 20_000);
    try {
      const [pos, ints, rc, wx, radio, pits, stints, laps] = await Promise.all([
        raw(q('position', { session_key: K, 'date>': since })), S.isRace ? raw(q('intervals', { session_key: K, 'date>': since })) : [],
        raw(q('race_control', { session_key: K, 'date>': since })), raw(q('weather', { session_key: K, 'date>': since })),
        raw(q('team_radio', { session_key: K, 'date>': since })), raw(q('pit', { session_key: K, 'date>': since })),
        raw(q('stints', { session_key: K })), raw(q('laps', { session_key: K, 'date_start>': iso(Date.now() - 300_000) })),
      ]);
      if (token !== S.token) continue;
      mergeGrouped(S.pos, pos); mergeGrouped(S.ints, ints);
      mergeGrouped(S.laps, laps.map((l) => ({ ...l, date: l.date_start })).filter((l) => l.date));
      // voltas já existentes podem ganhar lap_duration mais tarde
      for (const l of laps) { const arr = S.laps.get(l.driver_number); const ex = arr?.find((x) => x.lap_number === l.lap_number); if (ex) Object.assign(ex, l); }
      const addT = (list, rows) => { const seen = new Set(list.map((x) => x.date + (x.message || x.recording_url || x.driver_number))); for (const r of rows) { const k = r.date + (r.message || r.recording_url || r.driver_number); if (!seen.has(k)) list.push({ ...r, t: parseT(r.date) }); } list.sort((a, b) => a.t - b.t); };
      addT(S.rc, rc); addT(S.weather, wx); addT(S.radio, radio); addT(S.pits, pits);
      if (stints.length) S.stints = stints;
      S.lastRCCount = -1;
    } catch (e) { if (e.auth) { S.live = false; showAuthOrError(e); } }
  }
}

// ---------- Análise (gráficos) ----------
function positionsByLap() {
  const out = new Map();
  for (const [n, laps] of S.laps) {
    const arr = [];
    for (const l of laps) { if (!l.t) continue; const p = at(S.pos, n, l.t + 1000); if (p) arr.push({ lap: l.lap_number, pos: p.position }); }
    if (arr.length) out.set(n, arr);
  }
  return out;
}
let analysisTab = 'pos';
function renderAnalysis() {
  const el = $('#anaBody');
  const order = towerOrder(S.tEnd);
  const flat = [...S.laps.values()].flat();
  const totalLaps = Math.max(0, ...flat.map((l) => l.lap_number || 0));
  if (!flat.length) { el.innerHTML = '<p class="muted">Sem dados de voltas para esta sessão.</p>'; return; }
  if (analysisTab === 'pos') {
    if (!S.isRace) { el.innerHTML = '<p class="muted">O gráfico de posições por volta está disponível para corridas e sprints. Veja os tempos por volta.</p>'; return; }
    positionChart(el, positionsByLap(), S.drivers, order);
  } else if (analysisTab === 'laps') lapTimeChart(el, flat, S.drivers, { order });
  else strategyChart(el, S.stints, order, S.drivers, totalLaps);
}

// ---------- Página ----------
init(async () => {
  const app = $('#app');
  const NOW_Y = new Date().getFullYear();
  app.innerHTML = `
    <section class="page-hero container" style="padding-bottom:0">
      <div class="row-flex" style="justify-content:space-between">
        <div><h1>Ao <em>Vivo</em></h1><p>Durante as sessões, a tabela de tempos oficial da F1 em directo. Depois, o replay de qualquer sessão desde 2023: mapa da pista, torre de tempos, pneus, telemetria do piloto, rádio das equipas e direcção de corrida.</p></div>
      </div>
      <div class="controls mt">
        <select class="select" id="yearSel" aria-label="Ano">${Array.from({ length: NOW_Y - 2022 }, (_, i) => NOW_Y - i).map((y) => `<option>${y}</option>`).join('')}</select>
        <select class="select" id="meetSel" aria-label="Grande Prémio" style="min-width:220px"></select>
        <select class="select" id="sessSel" aria-label="Sessão"></select>
        <span id="status" class="muted" style="font-size:14px"></span>
      </div>
    </section>
    <section class="section container" style="padding-top:18px">
      <div id="officialLive" class="mb"></div>
      <div id="of1Note"></div>
      <div id="of1Wrap">
      <div class="row-flex mb"><h2 id="sessTitle" style="font-size:22px">—</h2><span id="liveChip"></span></div>
      <div class="live-layout">
        <div>
          <div class="track-box">
            <canvas id="track"></canvas>
            <div class="track-overlay"><span id="flag" class="flag-banner flag-GREEN">—</span><span class="lapbig" id="lapNo">—</span></div>
          </div>
          <div class="player mt-s">
            <button class="btn icon" id="back" title="-10 s (←)">↺</button>
            <button class="btn small" id="back1" title="-1 s (Shift+←)">−1s</button>
            <button class="btn icon primary" id="playBtn" title="Reproduzir / pausa">▶</button>
            <button class="btn small" id="fwd1" title="+1 s (Shift+→)">+1s</button>
            <button class="btn icon" id="fwd" title="+10 s (→)">↻</button>
            <span class="clock" id="clock">--:--:--</span>
            <input type="range" id="scrub" min="0" max="100" value="0" aria-label="Linha temporal">
            <select class="select" id="speed" aria-label="Velocidade">${[1, 2, 4, 8, 16, 32].map((s) => `<option value="${s}">${s}×</option>`).join('')}</select>
            <button class="btn small hidden" id="liveBtn">● DIRECTO</button>
          </div>
          <div class="row-flex mt-s" id="syncBar" style="font-size:13px">
            <span class="muted">Diferido:</span>
            <select class="select" id="jumpSel" aria-label="Saltar para um momento" style="max-width:100%"><option value="">Saltar para…</option></select>
            <span class="muted" style="font-size:12.5px">Pause o vídeo no mesmo momento, carregue ▶ nos dois e acerte com −1s / +1s.</span>
          </div>
          <div class="card mt-s hidden" id="drvPanel"></div>
          <div class="grid g-2 mt-s">
            <div class="card"><div class="card-title">Direcção de corrida</div><div class="feed" id="rc"></div></div>
            <div class="card"><div class="card-title">Meteorologia</div><div class="weather" id="weather"></div>
              <div class="card-title mt">Rádio das equipas</div><div class="feed radio" id="radio"></div></div>
          </div>
        </div>
        <div class="card flush" style="align-self:start">
          <div class="timing">
            <div class="row hd"><span>P</span><span></span><span>Piloto</span><span id="gapHd">Intervalo</span><span style="text-align:right">Última</span><span></span></div>
            <div id="tower"></div>
            <div id="towerRows" style="position:relative"></div>
          </div>
          <p class="muted" style="font-size:12.5px;padding:10px 12px">Clique num piloto (aqui ou no mapa) para ver velocidade, mudança, acelerador, travão e mini-sectores.</p>
        </div>
      </div>
      <div class="card mt">
        <div class="row-flex mb" style="justify-content:space-between"><div class="card-title" style="margin:0">Análise da sessão</div>
          <div class="tabs" id="anaTabs"><button class="tab active" data-tab="pos">Posições por volta</button><button class="tab" data-tab="laps">Tempos por volta</button><button class="tab" data-tab="tyres">Estratégia de pneus</button></div></div>
        <div id="anaBody">${skeleton(6)}</div>
      </div>
      <p class="muted mt" style="font-size:13px">Dados: OpenF1 (gratuito para sessões terminadas; dados em tempo real exigem conta paga na OpenF1). Posições no mapa a ~4 Hz, interpoladas.</p>
      </div>
    </section>`;

  mountOfficialLive($('#officialLive'));
  setupCanvas();
  requestAnimationFrame(loop);
  livePoll();

  $('#anaTabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (!b) return; $$('#anaTabs .tab').forEach((t) => t.classList.toggle('active', t === b)); analysisTab = b.dataset.tab; renderAnalysis(); });
  $('#playBtn').onclick = () => { S.followLive = false; S.playing = !S.playing; if (S.T >= S.tEnd) S.T = S.tStart; updatePlayer(); };
  $('#back').onclick = () => { S.followLive = false; S.T = clamp(S.T - 10_000, S.tStart, S.tEnd); updatePlayer(); updateTower(true); };
  const nudge = (ms) => { S.followLive = false; S.T = clamp(S.T + ms, S.tStart, S.tEnd); updatePlayer(); updateTower(true); };
  $('#back1').onclick = () => nudge(-1000);
  $('#fwd1').onclick = () => nudge(1000);
  $('#jumpSel').onchange = (e) => { const t = +e.target.value; if (!t) return; S.followLive = false; S.playing = false; S.speed = 1; $('#speed').value = '1'; S.T = clamp(t, S.tStart, S.tEnd); updatePlayer(); updateTower(true); e.target.value = ''; };
  $('#fwd').onclick = () => { S.followLive = false; S.T = clamp(S.T + 10_000, S.tStart, S.tEnd); updatePlayer(); updateTower(true); };
  $('#speed').onchange = (e) => { S.speed = +e.target.value; };
  $('#liveBtn').onclick = () => { S.followLive = !S.followLive; if (S.followLive) S.playing = false; updatePlayer(); };
  $('#scrub').oninput = (e) => { S.followLive = false; S.T = S.tStart + e.target.value * 1000; $('#clock').textContent = fmt.clock(S.T); updateTower(true); };
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,select,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); $('#playBtn').click(); }
    if (e.code === 'ArrowLeft') $(e.shiftKey ? '#back1' : '#back').click();
    if (e.code === 'ArrowRight') $(e.shiftKey ? '#fwd1' : '#fwd').click();
  });

  let meetings = [];
  const fillSessions = (mk, wantKey) => {
    const m = meetings.find(([k]) => String(k) === String(mk));
    if (!m) return;
    $('#sessSel').innerHTML = m[1].sessions.map((s) => `<option value="${s.session_key}" ${String(s.session_key) === String(wantKey) ? 'selected' : ''}>${esc(ptName(s.session_name))} · ${esc(fmt.weekday(parseT(s.date_start)))}</option>`).join('');
    if (!wantKey) { const race = m[1].sessions.findLast((s) => parseT(s.date_start) < Date.now()); if (race) $('#sessSel').value = race.session_key; }
  };
  const loadYear = async (y, want = {}) => {
    $('#meetSel').innerHTML = '<option>A carregar…</option>';
    try { meetings = await loadSessionList(y); } catch (e) { $('#status').textContent = 'OpenF1 indisponível: ' + e.message; meetings = []; return; }
    $('#meetSel').innerHTML = meetings.map(([k, v]) => `<option value="${k}">${flagTextCountry(v.meeting.country_name)} ${esc(v.meeting.meeting_name)}</option>`).join('');
    let mk = want.meeting ?? meetings.at(-1)?.[0];
    if (want.date) {
      const target = Date.parse(want.date);
      const hit = meetings.find(([, v]) => v.sessions.some((s) => Math.abs(parseT(s.date_start) - target) < 2 * 86400e3 && /Race/.test(s.session_name)));
      if (hit) mk = hit[0];
    }
    $('#meetSel').value = mk;
    fillSessions(mk, want.session);
    if (want.date) { const m = meetings.find(([k]) => k === mk); const race = m?.[1].sessions.find((s) => s.session_name === 'Race'); if (race) $('#sessSel').value = race.session_key; }
  };
  const start = () => {
    const m = meetings.find(([k]) => String(k) === $('#meetSel').value);
    const s = m?.[1].sessions.find((x) => String(x.session_key) === $('#sessSel').value);
    if (s) { $('#gapHd').textContent = /qual|practice|shootout/i.test(s.session_name) ? 'Melhor volta' : 'Intervalo'; loadSession(s, m[1].meeting); }
  };
  $('#yearSel').onchange = async (e) => { await loadYear(+e.target.value); start(); };
  $('#meetSel').onchange = () => { fillSessions($('#meetSel').value); start(); };
  $('#sessSel').onchange = start;

  // escolha inicial: sessão em directo > ?s= > ?d= > última sessão
  const wantS = qs('s'), wantD = qs('d');
  let year = NOW_Y, want = {};
  try {
    if (wantS) {
      const [s] = await getJSON(q('sessions', { session_key: wantS }), { ttl: 3600 });
      if (s) { year = s.year; want = { meeting: s.meeting_key, session: s.session_key }; }
    } else if (wantD) { year = +wantD.slice(0, 4); want = { date: wantD }; }
    else {
      // sessão em directo, senão a última corrida/sessão já terminada (essas têm sempre dados)
      const live = await currentLiveSession().catch(() => null);
      let s = live;
      if (!s) {
        let all = await getJSON(q('sessions', { year: NOW_Y }), { ttl: 1800 }).catch(() => []);
        let done = all.filter((x) => parseT(x.date_end) < Date.now() - 3600e3);
        if (!done.length) { all = await getJSON(q('sessions', { year: NOW_Y - 1 }), { ttl: 86400 }).catch(() => []); done = all.filter((x) => parseT(x.date_end) < Date.now() - 3600e3); }
        done.sort((a, b) => parseT(a.date_start) - parseT(b.date_start));
        const lastMeeting = done.at(-1)?.meeting_key;
        s = done.filter((x) => x.meeting_key === lastMeeting).findLast((x) => /Race|Qualifying/.test(x.session_name)) || done.at(-1);
      }
      if (s) { year = s.year; want = { meeting: s.meeting_key, session: s.session_key }; }
    }
  } catch { /* */ }
  $('#yearSel').value = year;
  await loadYear(year, want);
  start();
});
