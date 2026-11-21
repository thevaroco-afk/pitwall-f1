// =========================================================
// MAPA COM POSIÇÃO ESTIMADA — só com o feed público da F1 (sem GPS)
// A posição de cada carro é estimada a partir dos mini-sectores que vai
// completando (TimingData → Sectors → Segments), da passagem pela meta
// (NumberOfLaps) e do seu ritmo por volta. Entre dois mini-sectores o carro
// avança ao ritmo da última volta. Não é a posição real.
// =========================================================

const TM = {
  canvas: null, ctx: null, view: null, getState: null,
  trackKey: null, track: null, pts: null, cum: null, bounds: null, loading: false, failed: false,
  cars: new Map(), raf: 0, lastFrame: 0, visible: false,
};
const tmNow = () => performance.now();
const tmEnts = (o) => (o == null ? [] : Array.isArray(o) ? o.map((v, i) => [i, v]) : Object.entries(o).map(([k, v]) => [+k, v]));
const tmSecs = (s) => { if (!s || typeof s !== 'string') return null; const p = s.split(':').map(Number); return p.some(isNaN) ? null : p.reduce((a, x) => a * 60 + x, 0); };
const tmWrap = (d) => ((d % 1) + 1.5) % 1 - 0.5; // diferença circular em (-0.5, 0.5]

export function mountTrackMap(canvas, getState) {
  TM.canvas = canvas; TM.ctx = canvas.getContext('2d'); TM.getState = getState;
  new ResizeObserver(() => { TM.view = null; tmSizeCanvas(); }).observe(canvas);
  tmSizeCanvas();
}
function tmSizeCanvas() {
  const c = TM.canvas; if (!c) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  c.width = Math.max(1, c.clientWidth * dpr); c.height = Math.max(1, c.clientHeight * dpr);
  TM.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function setMapVisible(v) {
  TM.visible = v;
  if (v && !TM.raf) TM.raf = requestAnimationFrame(tmFrame);
}

// ---------- Traçado ----------
export async function ensureTrack(state) {
  const key = state.SessionInfo?.Meeting?.Circuit?.Key;
  if (!key || key === TM.trackKey || TM.loading) return;
  TM.trackKey = key; TM.loading = true; TM.failed = false; TM.pts = null; TM.view = null;
  const year = +(state.SessionInfo?.StartDate || '').slice(0, 4) || new Date().getFullYear();
  try {
    const r = await fetch(`api/live/track?key=${key}&year=${year}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    tmSetTrack(await r.json());
  } catch { TM.failed = true; }
  TM.loading = false;
}
function tmSetTrack(t) {
  const rot = ((t.rotation || 0) * Math.PI) / 180, c = Math.cos(rot), s = Math.sin(rot);
  const R = (x, y) => [x * c - y * s, x * s + y * c];
  let pts = t.x.map((x, i) => R(x, t.y[i]));
  // garantir o sentido de marcha: a curva 1 deve vir antes da última curva
  const corners = (t.corners || []).filter((k) => k.x != null).map((k) => ({ ...k, p: R(k.x, k.y) }));
  const near = (p) => { let bi = 0, bd = Infinity; pts.forEach(([x, y], i) => { const d = (x - p[0]) ** 2 + (y - p[1]) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
  if (corners.length >= 3) {
    const first = corners.reduce((a, b) => (b.n < a.n ? b : a)), last = corners.reduce((a, b) => (b.n > a.n ? b : a));
    if (near(first.p) > near(last.p)) pts = pts.reverse();
  }
  // fechar o circuito e calcular o comprimento acumulado
  pts.push(pts[0]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum.at(-1) || 1;
  TM.pts = pts; TM.cum = cum.map((v) => v / L);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  TM.bounds = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  TM.corners = corners;
  TM.view = null;
}
function tmPointAt(f) {
  f = ((f % 1) + 1) % 1;
  const c = TM.cum; let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= f) lo = m; else hi = m; }
  const t = (f - c[lo]) / ((c[hi] - c[lo]) || 1);
  const a = TM.pts[lo], b = TM.pts[hi];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// ---------- Geometria dos mini-sectores ----------
/** Fracção da volta no fim de cada mini-sector: ends[sector][segmento] */
function tmLayout(state) {
  const lines = state.TimingData?.Lines || {};
  const any = Object.values(lines).find((l) => l?.Sectors);
  const counts = any ? tmEnts(any.Sectors).map(([, s]) => tmEnts(s?.Segments).length || 1) : [1, 1, 1];
  // peso de cada sector = melhor tempo de sector da sessão (aprox. do seu comprimento)
  const best = counts.map((_, i) => {
    let m = Infinity;
    for (const st of Object.values(state.TimingStats?.Lines || {})) { const v = tmSecs(tmEnts(st?.BestSectors).find(([k]) => k === i)?.[1]?.Value); if (v && v < m) m = v; }
    return isFinite(m) ? m : null;
  });
  const w = best.every(Boolean) ? best : counts.map(() => 1);
  const W = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  return counts.map((n, i) => { const start = acc; acc += w[i] / W; return Array.from({ length: n }, (_, j) => start + ((j + 1) / n) * (w[i] / W)); });
}

function tmCar(n) { if (!TM.cars.has(n)) TM.cars.set(n, { f: null, t: 0, shown: null }); return TM.cars.get(n); }

/** Estado inicial: último mini-sector já completado na volta actual. */
export function onSnapshot(state) {
  const ends = tmLayout(state);
  for (const [n, l] of Object.entries(state.TimingData?.Lines || {})) {
    let f = 0;
    tmEnts(l?.Sectors).forEach(([si, s]) => tmEnts(s?.Segments).forEach(([gi, g]) => { if (g?.Status && ends[si]?.[gi] != null) f = Math.max(f, ends[si][gi] % 1); }));
    const c = tmCar(n); c.f = f; c.t = tmNow(); c.weak = true; // aproximado até ao próximo mini-sector
  }
}

/** Actualização do feed: cada mini-sector completado é uma "âncora" de posição. */
export function onDelta(topic, data, state) {
  if (topic !== 'TimingData' || !data?.Lines) return;
  const ends = tmLayout(state);
  for (const [n, l] of Object.entries(data.Lines)) {
    if (!l || typeof l !== 'object') continue;
    const c = tmCar(n);
    let best = null; // a âncora mais à frente neste pacote
    const consider = (f) => {
      f = f >= 0.999 ? 0 : f;
      if (best == null) best = f;
      else if (tmWrap(f - best) > 0) best = f;
    };
    if (l.NumberOfLaps != null) consider(0);
    for (const [si, s] of tmEnts(l.Sectors)) {
      if (!s || typeof s !== 'object') continue;
      for (const [gi, g] of tmEnts(s.Segments)) if (g?.Status && ends[si]?.[gi] != null) consider(ends[si][gi]);
      if (s.Value && ends[si]) consider(ends[si].at(-1));
    }
    if (best == null) continue;
    // ignorar âncoras "para trás" (ex.: correcções de estado já ultrapassadas)
    if (c.f != null && !c.weak && tmWrap(best - tmEstimate(n, state)) < -0.15) continue;
    if (c.weak) c.shown = null; // salta logo para a primeira posição fiável
    c.f = best; c.t = tmNow(); c.weak = false;
  }
}

function tmLapRef(state) {
  let m = Infinity;
  for (const l of Object.values(state.TimingData?.Lines || {})) { const v = tmSecs(l?.BestLapTime?.Value); if (v && v < m) m = v; }
  return isFinite(m) ? m : 95;
}
function tmEstimate(n, state) {
  const c = TM.cars.get(n); if (!c || c.f == null) return 0;
  const l = state.TimingData?.Lines?.[n] || {};
  const ref = tmLapRef(state);
  let lap = tmSecs(l.LastLapTime?.Value);
  if (!lap || lap < ref * 0.95 || lap > ref * 1.25) lap = ref * 1.04;
  const ts = String(state.TrackStatus?.Status || '1');
  if (ts === '4' || ts === '6' || ts === '7') lap *= 1.45; // SC / VSC
  if (ts === '5') return c.f;                               // bandeira vermelha: parados
  const ends = tmLayout(state).flat().sort((a, b) => a - b);
  const segLen = 1 / Math.max(ends.length, 3);
  const adv = Math.min((tmNow() - c.t) / 1000 / lap, segLen * 1.6); // nunca muito além do próximo mini-sector
  return c.f + adv;
}

// ---------- Desenho ----------
function tmMakeView() {
  const cv = TM.canvas, W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return null;
  if (!TM.pts) { // vista esquemática (circular) se não houver traçado
    const r = Math.min(W, H) / 2 - 28;
    return { W, H, at: (f) => [W / 2 + r * Math.sin(f * 2 * Math.PI), H / 2 - r * Math.cos(f * 2 * Math.PI)], ring: r };
  }
  const b = TM.bounds, bw = b.x1 - b.x0, bh = b.y1 - b.y0, pad = 42;
  const sc = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh);
  const ox = (W - bw * sc) / 2, oy = (H - bh * sc) / 2;
  const tr = ([x, y]) => [ox + (x - b.x0) * sc, H - (oy + (y - b.y0) * sc)];
  return { W, H, tr, at: (f) => tr(tmPointAt(f)) };
}

function tmFrame() {
  TM.raf = 0;
  if (!TM.visible) return;
  TM.raf = requestAnimationFrame(tmFrame);
  const t = tmNow(); const dt = Math.min(0.2, (t - (TM.lastFrame || t)) / 1000); TM.lastFrame = t;
  const ctx = TM.ctx, cv = TM.canvas; if (!ctx || !cv.clientWidth) return;
  if (!TM.view) TM.view = tmMakeView();
  const v = TM.view; if (!v) return;
  const state = TM.getState();
  ctx.clearRect(0, 0, v.W, v.H);

  // pista
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const path = new Path2D();
  if (TM.pts) TM.pts.forEach((p, i) => { const [x, y] = v.tr(p); i ? path.lineTo(x, y) : path.moveTo(x, y); });
  else path.arc(v.W / 2, v.H / 2, v.ring, 0, Math.PI * 2);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 13; ctx.stroke(path);
  ctx.strokeStyle = '#2e2e3c'; ctx.lineWidth = 9; ctx.stroke(path);
  // linha de meta
  const [sx, sy] = v.at(0);
  ctx.fillStyle = '#fff'; ctx.fillRect(sx - 2, sy - 8, 4, 16);

  // carros
  const lines = state.TimingData?.Lines || {}, drivers = state.DriverList || {};
  const order = Object.keys(lines).sort((a, b) => (+(lines[b].Position || 99)) - (+(lines[a].Position || 99)));
  for (const n of order) {
    const l = lines[n], d = drivers[n] || {}, c = TM.cars.get(n);
    if (!c || c.f == null || l.InPit || l.Retired || l.Stopped) continue;
    const target = tmEstimate(n, state);
    c.shown = c.shown == null ? target : c.shown + tmWrap(target - c.shown) * Math.min(1, dt * 3);
    const [x, y] = v.at(c.shown);
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = d.TeamColour ? `#${d.TeamColour}` : '#888'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.stroke();
    ctx.font = '800 10.5px "Titillium Web", sans-serif';
    const label = d.Tla || n, tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(8,8,12,.8)'; ctx.fillRect(x + 8, y - 7, tw + 7, 14);
    ctx.fillStyle = '#e8e8f0'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(label, x + 11.5, y);
  }
  if (!TM.pts) {
    ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.font = '600 12px "Titillium Web", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(TM.loading ? 'A carregar traçado…' : 'Vista esquemática (traçado indisponível)', v.W / 2, v.H / 2);
  }
}
