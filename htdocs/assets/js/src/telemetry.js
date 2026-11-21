// =========================================================
// TELEMETRIA — FastF1 (exportado) ou OpenF1 (2023+)
// =========================================================
import { init, $, $$, esc, getJSON, getLocal, parseT, fmt, flagCountry, skeleton, errorBox, qs, setQs, hex, clamp } from './core.js';
import { CONFIG } from './config.js';
import { LineChart, ChartGroup } from './charts.js';
import { strategyChart, lapTimeChart, TYRE_COLORS, tyreLetter } from './raceviz.js';

const API = CONFIG.openf1;
const MAX_SEL = 4;
const q = (path, params) => `${API}/${path}?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
const iso = (ms) => new Date(ms).toISOString().slice(0, 23);

const S = { source: null, sess: null, sel: [], lapChoice: new Map(), laps: new Map(), mapMode: 'dominance', group: new ChartGroup(), cursorD: null };

// ---------- utilitários numéricos ----------
function interp(xs, ys, x) {
  if (!xs.length) return null;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const f = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * f;
}

// ---------- Fonte: FastF1 ----------
const FastF1 = {
  async index() { const d = await getLocal(`${CONFIG.telemetryData}/index.json`); return d?.sessions?.length ? d.sessions : null; },
  async load(id) {
    const m = await getLocal(`${CONFIG.telemetryData}/${id}/meta.json`);
    if (!m) throw new Error('meta.json não encontrado');
    const drivers = new Map(m.drivers.filter((d) => m.telemetryDrivers.includes(d.abbr)).map((d) => [d.abbr, { key: d.abbr, acr: d.abbr, name: d.name, team: d.team, color: hex(d.color), bestLap: d.bestLap, bestLapNumber: d.bestLapNumber, position: d.position, headshot: d.headshot }]));
    const laps = m.laps.map((l) => ({ key: l.d, n: l.n, t: l.t, s1: l.s1, s2: l.s2, s3: l.s3, compound: l.c, life: l.life, stint: l.stint, pitOut: l.pitOut, pitIn: l.pitIn, deleted: l.del }));
    return { id, title: `${flagCountry(m.country)} ${m.event} · ${m.sessionName} ${m.year}`, drivers, laps, corners: m.circuit?.corners || [], rotation: m.circuit?.rotation || 0, allLaps: m.lapsMode === 'all', raw: m, isRace: /Race|Sprint$/.test(m.session) };
  },
  async lap(sess, key, which) {
    const file = await getLocal(`${CONFIG.telemetryData}/${sess.id}/${key}.json`);
    if (!file) throw new Error('sem telemetria');
    const k = which === 'fastest' ? 'fastest' : `lap${which}`;
    const L = file.laps[k] || file.laps.fastest;
    return { ...L, t: L.t.map((v) => v - L.t[0]) };
  },
};

// ---------- Fonte: OpenF1 ----------
const OpenF1 = {
  async sessions(year) {
    const [ss, ms] = await Promise.all([getJSON(q('sessions', { year }), { ttl: 1800 }), getJSON(q('meetings', { year }), { ttl: 3600 }).catch(() => [])]);
    const mm = new Map(ms.map((m) => [m.meeting_key, m]));
    return ss.filter((s) => parseT(s.date_end) < Date.now()).map((s) => ({ ...s, meeting: mm.get(s.meeting_key) })).filter((s) => !/test/i.test(s.meeting?.meeting_name || ''));
  },
  async load(s) {
    const K = s.session_key;
    const [drv, laps, stints] = await Promise.all([getJSON(q('drivers', { session_key: K }), { ttl: 86400 }), getJSON(q('laps', { session_key: K }), { ttl: 86400 }), getJSON(q('stints', { session_key: K }), { ttl: 86400 }).catch(() => [])]);
    const stintOf = (num, lap) => stints.find((x) => x.driver_number === num && lap >= x.lap_start && lap <= (x.lap_end || 999));
    const L = laps.map((l) => { const st = stintOf(l.driver_number, l.lap_number); return { key: l.driver_number, n: l.lap_number, t: l.lap_duration, s1: l.duration_sector_1, s2: l.duration_sector_2, s3: l.duration_sector_3, compound: st?.compound, life: st ? (st.tyre_age_at_start || 0) + l.lap_number - st.lap_start : null, stint: st?.stint_number, pitOut: l.is_pit_out_lap, date: l.date_start, st: l.st_speed }; });
    const drivers = new Map();
    for (const d of drv) {
      const my = L.filter((l) => l.key === d.driver_number && l.t && !l.pitOut);
      const best = my.sort((a, b) => a.t - b.t)[0];
      drivers.set(d.driver_number, { key: d.driver_number, acr: d.name_acronym, name: d.full_name, team: d.team_name, color: hex(d.team_colour || '888888'), bestLap: best?.t, bestLapNumber: best?.n, headshot: d.headshot_url });
    }
    for (const [k, d] of drivers) if (!d.bestLap) drivers.delete(k);
    const order = [...drivers.values()].sort((a, b) => a.bestLap - b.bestLap);
    return { id: K, title: `${flagCountry(s.country_name)} ${s.meeting?.meeting_name || s.country_name} · ${s.session_name} ${s.year}`, drivers: new Map(order.map((d) => [d.key, d])), laps: L, stints, corners: [], rotation: 0, allLaps: true, isRace: s.session_type === 'Race' };
  },
  async lap(sess, key, which) {
    const n = which === 'fastest' ? sess.drivers.get(key).bestLapNumber : +which;
    const lap = sess.laps.find((l) => l.key === key && l.n === n);
    if (!lap?.date || !lap.t) throw new Error('volta sem dados');
    const t0 = parseT(lap.date), t1 = t0 + lap.t * 1000;
    const [car, loc] = await Promise.all([
      getJSON(q('car_data', { session_key: sess.id, driver_number: key, 'date>': iso(t0 - 300), 'date<': iso(t1 + 300) }), { ttl: 86400 }),
      getJSON(q('location', { session_key: sess.id, driver_number: key, 'date>': iso(t0 - 300), 'date<': iso(t1 + 300) }), { ttl: 86400 }),
    ]);
    const C = car.map((c) => ({ ...c, ms: parseT(c.date) })).sort((a, b) => a.ms - b.ms);
    const P = loc.filter((p) => p.x || p.y).map((p) => ({ ...p, ms: parseT(p.date) })).sort((a, b) => a.ms - b.ms);
    if (C.length < 10) throw new Error('sem car_data');
    // distância por integração da velocidade, normalizada para começar em t0
    const out = { d: [], t: [], speed: [], throttle: [], brake: [], gear: [], rpm: [], drs: [], x: [], y: [], lap: n, lapTime: lap.t, compound: lap.compound };
    let dist = 0, prev = null;
    const px = P.map((p) => p.ms), xs = P.map((p) => p.x), ys = P.map((p) => p.y);
    for (const c of C) {
      if (c.ms < t0 || c.ms > t1) continue;
      if (prev) dist += ((prev.speed + c.speed) / 2 / 3.6) * ((c.ms - prev.ms) / 1000);
      prev = c;
      out.d.push(+dist.toFixed(1)); out.t.push((c.ms - t0) / 1000);
      out.speed.push(c.speed); out.throttle.push(clamp(c.throttle, 0, 100)); out.brake.push(c.brake > 0 ? 100 : 0); out.gear.push(c.n_gear); out.rpm.push(c.rpm); out.drs.push(c.drs >= 10 ? 1 : 0);
      out.x.push(P.length ? interp(px, xs, c.ms) : null); out.y.push(P.length ? interp(px, ys, c.ms) : null);
    }
    return out;
  },
};

// ---------- Selecção e carregamento ----------
async function getLap(key) {
  const which = S.lapChoice.get(key) || 'fastest';
  const ck = `${S.sess.id}|${key}|${which}`;
  if (!S.laps.has(ck)) S.laps.set(ck, S.source.lap(S.sess, key, which).catch((e) => { S.laps.delete(ck); throw e; }));
  return S.laps.get(ck);
}

function renderPicker() {
  const el = $('#drvPick');
  el.innerHTML = [...S.sess.drivers.values()].map((d) => {
    const on = S.sel.includes(d.key);
    return `<button data-k="${d.key}" class="${on ? 'on' : ''}" style="${on ? `color:${d.color}` : ''}" ${!on && S.sel.length >= MAX_SEL ? 'disabled' : ''}><i style="background:${d.color}"></i><span style="color:var(--text)">${esc(d.acr)}</span><span class="mono muted" style="font-size:11.5px">${fmt.lap(d.bestLap)}</span></button>`;
  }).join('');
}

async function analyse() {
  setQs({ drv: S.sel.join(',') });
  renderPicker();
  const body = $('#teleBody');
  S.group.clear();
  if (!S.sel.length) { body.innerHTML = `<div class="card">${errorBox('Escolha até 4 pilotos para comparar.')}</div>`; return; }
  body.innerHTML = `<div class="card">${skeleton(10)}</div>`;
  const results = await Promise.allSettled(S.sel.map(getLap));
  const L = [];
  results.forEach((r, i) => { if (r.status === 'fulfilled' && r.value?.d?.length) L.push({ drv: S.sess.drivers.get(S.sel[i]), data: r.value }); });
  if (!L.length) { body.innerHTML = `<div class="card">${errorBox('Não há telemetria para estas voltas.', results.find((r) => r.status === 'rejected')?.reason?.message)}</div>`; return; }

  // companheiros de equipa têm a mesma cor: usar cores alternativas
  const ALT = ['#ffffff', '#ffd60a', '#b14cff', '#22d36b'];
  const used = new Set();
  for (const l of L) { if (used.has(l.drv.color.toLowerCase())) l.drv = { ...l.drv, color: ALT.find((c) => !used.has(c)) }; used.add(l.drv.color.toLowerCase()); }
  // normalizar distância à volta de referência (primeiro piloto)
  const ref = L[0];
  const refLen = ref.data.d.at(-1);
  for (const l of L) { const k = refLen / (l.data.d.at(-1) || refLen); l.nd = l.data.d.map((v) => v * k); }
  // delta face à referência
  for (const l of L.slice(1)) l.delta = ref.nd.map((d, i) => interp(l.nd, l.data.t, d) - ref.data.t[i]);

  const stats = (l) => {
    const sp = l.data.speed; const n = sp.length;
    const ft = l.data.throttle.filter((v) => v >= 98).length / n;
    const br = l.data.brake.filter((v) => v > 0).length / n;
    const drs = l.data.drs.filter((v) => v).length / n;
    let shifts = 0; for (let i = 1; i < n; i++) if (l.data.gear[i] !== l.data.gear[i - 1]) shifts++;
    return { vmax: Math.max(...sp), vavg: sp.reduce((a, b) => a + b, 0) / n, ft, br, drs, shifts, vmin: Math.min(...sp.filter((v) => v > 30)) };
  };
  const lapOpts = (key) => {
    const my = S.sess.laps.filter((l) => l.key === key && l.t).sort((a, b) => a.n - b.n);
    const cur = S.lapChoice.get(key) || 'fastest';
    const opts = [`<option value="fastest" ${cur === 'fastest' ? 'selected' : ''}>Volta mais rápida</option>`];
    if (S.sess.allLaps) for (const l of my) opts.push(`<option value="${l.n}" ${String(cur) === String(l.n) ? 'selected' : ''}>V${l.n} · ${fmt.lap(l.t)}${l.compound ? ' · ' + tyreLetter(l.compound) : ''}${l.pitOut ? ' · saída box' : ''}</option>`);
    return opts.join('');
  };
  const sectors = (l) => S.sess.laps.find((x) => x.key === l.drv.key && x.n === l.data.lap) || {};
  const bestSec = [1, 2, 3].map((i) => Math.min(...L.map((l) => sectors(l)['s' + i] || Infinity)));

  body.innerHTML = `
    <div class="tele-head">${L.map((l, i) => { const s = sectors(l); const st = stats(l); return `<div class="d" style="border-color:${l.drv.color}">
      <div class="row-flex" style="justify-content:space-between"><span class="n">${esc(l.drv.name || l.drv.acr)}</span>${l.data.compound ? `<span class="tyre ${l.data.compound}">${tyreLetter(l.data.compound)}</span>` : ''}</div>
      <div class="lt">${fmt.lap(l.data.lapTime)} ${i > 0 ? `<span style="font-size:15px;color:${l.data.lapTime - ref.data.lapTime > 0 ? 'var(--red)' : 'var(--green)'}">${l.data.lapTime - ref.data.lapTime > 0 ? '+' : ''}${(l.data.lapTime - ref.data.lapTime).toFixed(3)}</span>` : '<span class="chip" style="vertical-align:middle">REF</span>'}</div>
      <div class="sx">${[1, 2, 3].map((k) => `<span style="color:${s['s' + k] && s['s' + k] === bestSec[k - 1] ? 'var(--purple)' : 'inherit'}">S${k} ${s['s' + k] ? s['s' + k].toFixed(3) : '—'}</span>`).join('')}</div>
      <div class="sx mt-s"><span>Vmáx ${fmt.num(st.vmax)} km/h</span><span>Vméd ${fmt.num(st.vavg)} km/h</span></div>
      <select class="select mt-s lapSel" data-k="${l.drv.key}" style="width:100%;min-height:34px;padding:5px 30px 5px 10px;font-size:13.5px">${lapOpts(l.drv.key)}</select>
    </div>`; }).join('')}</div>
    <div class="grid g-main mt">
      <div class="card"><div class="card-title">Mapa do circuito <span class="right"><span class="tabs" id="mapMode" style="display:inline-flex"><button class="tab ${S.mapMode === 'dominance' ? 'active' : ''}" data-tab="dominance">Domínio</button><button class="tab ${S.mapMode === 'speed' ? 'active' : ''}" data-tab="speed">Velocidade</button><button class="tab ${S.mapMode === 'gear' ? 'active' : ''}" data-tab="gear">Mudanças</button></span></span></div>
        <div class="track-box" style="aspect-ratio:16/11"><canvas id="teleMap"></canvas></div><div class="legend" id="mapLegend"></div></div>
      <div class="card"><div class="card-title">Resumo da volta</div><div class="table-wrap"><table class="t" style="font-size:14px"><thead><tr><th></th>${L.map((l) => `<th class="r" style="color:${l.drv.color}">${esc(l.drv.acr)}</th>`).join('')}</tr></thead><tbody>
        ${[['Velocidade máx.', (s) => fmt.num(s.vmax) + ' km/h'], ['Velocidade média', (s) => fmt.num(s.vavg, 1) + ' km/h'], ['Velocidade mín.', (s) => fmt.num(s.vmin) + ' km/h'], ['Acelerador a fundo', (s) => fmt.num(s.ft * 100, 1) + '%'], ['A travar', (s) => fmt.num(s.br * 100, 1) + '%'], ['DRS aberto', (s) => fmt.num(s.drs * 100, 1) + '%'], ['Mudanças de caixa', (s) => s.shifts]].map(([lbl, f]) => `<tr><td class="muted">${lbl}</td>${L.map((l) => `<td class="r mono">${f(stats(l))}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>
      <p class="muted mt-s" style="font-size:12.5px">Distâncias normalizadas à volta de referência (${esc(ref.drv.acr)}: ${fmt.num(refLen)} m). Arraste nos gráficos para ampliar, duplo-clique para repor.</p></div>
    </div>
    <div class="card mt"><div class="card-title">Velocidade (km/h)</div><div id="cSpeed"></div></div>
    ${L.length > 1 ? `<div class="card mt-s"><div class="card-title">Delta para ${esc(ref.drv.acr)} (s) <span class="right muted">acima de zero = mais lento</span></div><div id="cDelta"></div></div>` : ''}
    <div class="grid g-2 mt-s"><div class="card"><div class="card-title">Acelerador (%)</div><div id="cThr"></div></div><div class="card"><div class="card-title">Travão</div><div id="cBrk"></div></div></div>
    <div class="grid g-2 mt-s"><div class="card"><div class="card-title">Mudança engrenada</div><div id="cGear"></div></div><div class="card"><div class="card-title">RPM</div><div id="cRpm"></div></div></div>`;

  const xF = (v) => `${(v / 1000).toFixed(1)} km`;
  const markers = (S.sess.corners || []).map((c) => ({ x: c.dist, label: `${c.n}${c.l || ''}` }));
  const mk = (id, key, opts = {}) => {
    const el = $('#' + id); if (!el) return;
    const series = L.map((l) => ({ name: l.drv.acr, color: l.drv.color, xs: l.nd, ys: l.data[key], width: 1.6 }));
    const c = new LineChart(el, series, { xFormat: xF, legend: false, onCursor: (x) => { S.cursorD = x; drawMap(L); }, tipTitle: (x) => xF(x), ...opts });
    S.group.add(c);
  };
  mk('cSpeed', 'speed', { height: 280, yFormat: (v) => Math.round(v), markers });
  if (L.length > 1) {
    const el = $('#cDelta');
    const c = new LineChart(el, L.slice(1).map((l) => ({ name: l.drv.acr, color: l.drv.color, xs: ref.nd, ys: l.delta, width: 2 })), { height: 170, xFormat: xF, yFormat: (v) => (v > 0 ? '+' : '') + v.toFixed(2), zeroLine: true, legend: false, onCursor: (x) => { S.cursorD = x; drawMap(L); }, tipTitle: (x) => xF(x) });
    S.group.add(c);
  }
  mk('cThr', 'throttle', { height: 150, yMin: 0, yMax: 100, yFormat: (v) => Math.round(v) });
  mk('cBrk', 'brake', { height: 150, yMin: 0, yMax: 100, step: true, yFormat: (v) => (v > 0 ? 'ON' : 'OFF'), yTicks: [0, 100] });
  mk('cGear', 'gear', { height: 150, yMin: 0, yMax: 8.5, step: true, yFormat: (v) => Math.round(v), yTicks: [1, 2, 3, 4, 5, 6, 7, 8] });
  mk('cRpm', 'rpm', { height: 150, yFormat: (v) => fmt.num(v) });

  $$('.lapSel', body).forEach((s) => s.addEventListener('change', () => { S.lapChoice.set(isNaN(+s.dataset.k) ? s.dataset.k : +s.dataset.k, s.value); analyse(); }));
  $('#mapMode').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (!b) return; S.mapMode = b.dataset.tab; $$('#mapMode .tab').forEach((t) => t.classList.toggle('active', t === b)); drawMap(L); });
  const cv = $('#teleMap');
  new ResizeObserver(() => drawMap(L)).observe(cv);
  drawMap(L);
}

// ---------- Mapa ----------
function speedColor(v, min, max) { const f = clamp((v - min) / (max - min || 1), 0, 1); return `hsl(${240 - f * 240} 90% ${45 + f * 10}%)`; }
const GEAR_COL = ['#444', '#6a00ff', '#3b5bff', '#00a6ff', '#00d18f', '#7bd300', '#ffd000', '#ff7a00', '#ff1e2d'];
function drawMap(L) {
  const cv = $('#teleMap'); if (!cv || !L.length) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = cv.clientWidth, H = cv.clientHeight; if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const ref = L[0];
  const X = ref.data.x, Y = ref.data.y;
  if (!X?.length || X[0] == null) { ctx.fillStyle = '#7d7d92'; ctx.font = '14px Titillium Web'; ctx.fillText('Sem coordenadas para esta volta.', 16, 24); return; }
  const rot = ((S.sess.rotation || 0) * Math.PI) / 180;
  const R = (x, y) => [x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)];
  const P = X.map((x, i) => R(x, Y[i]));
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const pad = 30, sc = Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0));
  const ox = (W - (x1 - x0) * sc) / 2, oy = (H - (y1 - y0) * sc) / 2;
  const T = ([x, y]) => [ox + (x - x0) * sc, H - (oy + (y - y0) * sc)];
  const S2 = P.map(T);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000'; ctx.lineWidth = 13; ctx.beginPath(); S2.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
  const legend = $('#mapLegend');
  ctx.lineWidth = 7;
  if (S.mapMode === 'dominance' && L.length > 1) {
    const N = 25, len = ref.nd.at(-1);
    const winners = [];
    for (let k = 0; k < N; k++) {
      const a = (len * k) / N, b = (len * (k + 1)) / N;
      let best = null;
      for (const l of L) { const dt = interp(l.nd, l.data.t, b) - interp(l.nd, l.data.t, a); if (!best || dt < best.dt) best = { l, dt }; }
      winners.push(best.l);
    }
    for (let i = 1; i < S2.length; i++) {
      const k = Math.min(N - 1, Math.floor((ref.nd[i] / len) * N));
      ctx.strokeStyle = winners[k].drv.color; ctx.beginPath(); ctx.moveTo(...S2[i - 1]); ctx.lineTo(...S2[i]); ctx.stroke();
    }
    const cnt = new Map(); winners.forEach((w) => cnt.set(w.drv.acr, (cnt.get(w.drv.acr) || 0) + 1));
    legend.innerHTML = L.map((l) => `<span><i style="background:${l.drv.color}"></i>${esc(l.drv.acr)} · ${cnt.get(l.drv.acr) || 0}/${N} mini-sectores</span>`).join('');
  } else if (S.mapMode === 'gear') {
    for (let i = 1; i < S2.length; i++) { ctx.strokeStyle = GEAR_COL[ref.data.gear[i]] || '#888'; ctx.beginPath(); ctx.moveTo(...S2[i - 1]); ctx.lineTo(...S2[i]); ctx.stroke(); }
    legend.innerHTML = GEAR_COL.slice(1).map((c, i) => `<span><i style="background:${c}"></i>${i + 1}ª</span>`).join('') + `<span class="muted">· ${esc(ref.drv.acr)}</span>`;
  } else {
    const sp = ref.data.speed, mn = Math.min(...sp), mx = Math.max(...sp);
    for (let i = 1; i < S2.length; i++) { ctx.strokeStyle = speedColor(sp[i], mn, mx); ctx.beginPath(); ctx.moveTo(...S2[i - 1]); ctx.lineTo(...S2[i]); ctx.stroke(); }
    legend.innerHTML = `<span><i style="background:linear-gradient(90deg,hsl(240 90% 45%),hsl(120 90% 50%),hsl(0 90% 55%));width:80px"></i>${fmt.num(mn)} → ${fmt.num(mx)} km/h · ${esc(ref.drv.acr)}</span>`;
  }
  // curvas
  ctx.font = '700 10.5px JetBrains Mono'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (const c of S.sess.corners || []) {
    const [rx, ry] = R(c.x, c.y);
    const ang = Math.atan2(ry - cy, rx - cx);
    const [sx, sy] = T([rx + Math.cos(ang) * 0, ry + Math.sin(ang) * 0]);
    const ox2 = Math.cos(ang) * 16, oy2 = -Math.sin(ang) * 16;
    ctx.fillStyle = 'rgba(20,20,28,.9)'; ctx.beginPath(); ctx.arc(sx + ox2, sy + oy2, 8.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#cfcfe0'; ctx.fillText(`${c.n}${c.l || ''}`, sx + ox2, sy + oy2 + .5);
  }
  // linha de partida
  ctx.fillStyle = '#fff'; const [s0x, s0y] = S2[0]; ctx.fillRect(s0x - 2, s0y - 8, 4, 16);
  // cursor
  if (S.cursorD != null) {
    for (const l of L) {
      const xr = interp(l.nd, l.data.x, S.cursorD), yr = interp(l.nd, l.data.y, S.cursorD);
      if (xr == null) continue;
      const [sx, sy] = T(R(xr, yr));
      ctx.fillStyle = l.drv.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 7); ctx.fill(); ctx.stroke();
    }
  }
}

// ---------- Análise da sessão ----------
function renderSessionCharts() {
  const el = $('#sessCharts');
  const drivers = new Map([...S.sess.drivers.values()].map((d) => [d.key, { acr: d.acr, color: d.color }]));
  const order = [...S.sess.drivers.keys()];
  const laps = S.sess.laps.filter((l) => drivers.has(l.key)).map((l) => ({ driver_number: l.key, lap_number: l.n, lap_duration: l.deleted ? null : l.t, is_pit_out_lap: l.pitOut || l.pitIn }));
  el.innerHTML = `<div class="card"><div class="row-flex mb" style="justify-content:space-between"><div class="card-title" style="margin:0">Sessão completa</div><div class="tabs" id="sTabs"><button class="tab active" data-tab="laps">Tempos por volta</button><button class="tab" data-tab="tyres">Pneus</button></div></div><div id="sBody"></div></div>`;
  const stints = S.sess.stints || (() => {
    const out = []; const seen = new Map();
    for (const l of S.sess.laps) {
      if (!l.stint) continue; const k = `${l.key}|${l.stint}`;
      if (!seen.has(k)) { const s = { driver_number: l.key, stint_number: l.stint, compound: l.compound, lap_start: l.n, lap_end: l.n, tyre_age_at_start: Math.max(0, (l.life || 1) - 1) }; seen.set(k, s); out.push(s); } else seen.get(k).lap_end = l.n;
    }
    return out;
  })();
  const show = (t) => { const b = $('#sBody'); if (t === 'laps') lapTimeChart(b, laps, drivers, { order }); else strategyChart(b, stints, order, drivers); };
  show('laps');
  $('#sTabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (!b) return; $$('#sTabs .tab').forEach((x) => x.classList.toggle('active', x === b)); show(b.dataset.tab); });
}

async function openSession(source, ref) {
  S.source = source; S.laps.clear(); S.lapChoice.clear();
  $('#teleBody').innerHTML = `<div class="card">${skeleton(8)}</div>`;
  $('#drvPick').innerHTML = '';
  try { S.sess = await source.load(ref); }
  catch (e) { $('#teleBody').innerHTML = `<div class="card">${errorBox('Não foi possível carregar a sessão.', e.message)}</div>`; return; }
  $('#teleTitle').innerHTML = S.sess.title;
  const want = (qs('drv') || '').split(',').filter(Boolean).map((k) => (S.sess.drivers.has(k) ? k : +k)).filter((k) => S.sess.drivers.has(k));
  S.sel = want.length ? want.slice(0, MAX_SEL) : [...S.sess.drivers.keys()].slice(0, 2);
  renderSessionCharts();
  await analyse();
}

// ---------- Página ----------
init(async () => {
  const NOW_Y = new Date().getFullYear();
  $('#app').innerHTML = `
    <section class="page-hero container">
      <h1>Tele<em>metria</em></h1>
      <p>Compare voltas lado a lado: velocidade, acelerador, travão, mudanças e RPM, delta ao longo da volta e quem domina cada mini-sector. Passe o rato pelos gráficos para seguir os carros no mapa.</p>
      <div class="tabs mt" id="srcTabs" style="display:inline-flex"><button class="tab" data-tab="fastf1">FastF1 · alta resolução</button><button class="tab" data-tab="openf1">OpenF1 · 2023+</button></div>
      <div class="controls mt" id="srcControls"></div>
    </section>
    <section class="section container" style="padding-top:10px">
      <h2 id="teleTitle" style="font-size:22px;margin-bottom:12px">—</h2>
      <div class="drv-pick mb" id="drvPick"></div>
      <div id="teleBody"></div>
      <div id="sessCharts" class="mt"></div>
    </section>`;

  const ffIndex = await FastF1.index();
  const ctl = $('#srcControls');

  const useFastF1 = () => {
    if (!ffIndex?.length) {
      ctl.innerHTML = `<div class="notice" style="max-width:760px">Ainda não há sessões FastF1 exportadas. No seu computador, corra <code>pip install fastf1</code> e depois <code>python tools/fastf1_export.py 2025 Monaco R</code>, e envie a pasta <code>data/telemetry</code> para o site. Entretanto, use a fonte <b>OpenF1</b>.</div>`;
      $('#teleBody').innerHTML = ''; $('#drvPick').innerHTML = ''; $('#sessCharts').innerHTML = ''; $('#teleTitle').textContent = '';
      return;
    }
    ctl.innerHTML = `<select class="select" id="ffSel" style="min-width:320px">${ffIndex.map((s) => `<option value="${esc(s.id)}">${s.year} · ${esc(s.event)} · ${esc(s.sessionName)}</option>`).join('')}</select>`;
    const want = qs('ff');
    if (want && ffIndex.some((s) => s.id === want)) $('#ffSel').value = want;
    $('#ffSel').onchange = (e) => { setQs({ ff: e.target.value, s: null, drv: null }); openSession(FastF1, e.target.value); };
    setQs({ ff: $('#ffSel').value, s: null });
    openSession(FastF1, $('#ffSel').value);
  };

  const useOpenF1 = async () => {
    ctl.innerHTML = `<select class="select" id="oY">${Array.from({ length: NOW_Y - 2022 }, (_, i) => NOW_Y - i).map((y) => `<option>${y}</option>`).join('')}</select><select class="select" id="oS" style="min-width:320px"><option>A carregar…</option></select>`;
    let list = [];
    const fill = async (y, wantKey, wantDate) => {
      try { list = (await OpenF1.sessions(y)).sort((a, b) => parseT(b.date_start) - parseT(a.date_start)); }
      catch (e) { $('#oS').innerHTML = '<option>OpenF1 indisponível</option>'; return; }
      $('#oS').innerHTML = list.map((s) => `<option value="${s.session_key}">${esc(s.meeting?.meeting_name || s.country_name)} · ${esc(s.session_name)}</option>`).join('');
      let pick = list.find((s) => String(s.session_key) === String(wantKey));
      if (!pick && wantDate) pick = list.find((s) => s.session_name === 'Race' && Math.abs(parseT(s.date_start) - Date.parse(wantDate)) < 2 * 86400e3);
      if (!pick) pick = list.find((s) => /Qualifying|Race/.test(s.session_name)) || list[0];
      if (pick) $('#oS').value = pick.session_key;
    };
    const go = () => { const s = list.find((x) => String(x.session_key) === $('#oS').value); if (s) { setQs({ s: s.session_key, ff: null, d: null }); openSession(OpenF1, s); } };
    $('#oY').onchange = async (e) => { setQs({ drv: null }); await fill(+e.target.value); go(); };
    $('#oS').onchange = () => { setQs({ drv: null }); go(); };
    const wantS = qs('s'), wantD = qs('d');
    let y = NOW_Y;
    if (wantD) y = +wantD.slice(0, 4);
    if (wantS) { try { const [s] = await getJSON(q('sessions', { session_key: wantS }), { ttl: 86400 }); if (s) y = s.year; } catch { /* */ } }
    $('#oY').value = y;
    await fill(y, wantS, wantD);
    if (!list.length && y === NOW_Y) { $('#oY').value = y - 1; await fill(y - 1); }
    go();
  };

  const setSrc = (t) => { $$('#srcTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t)); t === 'fastf1' ? useFastF1() : useOpenF1(); };
  $('#srcTabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) { setQs({ drv: null }); setSrc(b.dataset.tab); } });
  $('#drvPick').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]'); if (!b || !S.sess) return;
    const k = S.sess.drivers.has(b.dataset.k) ? b.dataset.k : +b.dataset.k;
    S.sel = S.sel.includes(k) ? S.sel.filter((x) => x !== k) : [...S.sel, k].slice(0, MAX_SEL);
    analyse();
  });
  setSrc(qs('s') || qs('d') || !ffIndex ? 'openf1' : 'fastf1');
});
