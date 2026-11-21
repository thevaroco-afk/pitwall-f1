// Visualizações partilhadas: estratégia de pneus, gráfico de posições e tempos por volta
import { esc, fmt, hex } from './core.js';
import { LineChart } from './charts.js';

export const TYRE_COLORS = { SOFT: '#ff3b3b', MEDIUM: '#ffd60a', HARD: '#f2f2f2', INTERMEDIATE: '#2fbf4a', WET: '#2f7dff', UNKNOWN: '#666', TEST_UNKNOWN: '#666' };
export const tyreLetter = (c) => ({ SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' }[c] || '?');

/**
 * stints: [{driver_number, stint_number, compound, lap_start, lap_end, tyre_age_at_start}]
 * order: driver_numbers ordenados; drivers: Map num -> {acr, color}
 */
export function strategyChart(el, stints, order, drivers, totalLaps) {
  const byD = new Map();
  for (const s of stints) { if (!byD.has(s.driver_number)) byD.set(s.driver_number, []); byD.get(s.driver_number).push(s); }
  const maxLap = totalLaps || Math.max(1, ...stints.map((s) => s.lap_end || s.lap_start || 0));
  const rows = order.filter((n) => byD.has(n));
  if (!rows.length) { el.innerHTML = '<p class="muted">Sem dados de pneus para esta sessão.</p>'; return; }
  const ticks = [];
  const step = maxLap > 40 ? 10 : 5;
  for (let l = step; l < maxLap; l += step) ticks.push(l);
  el.innerHTML = `<div style="position:relative;padding-left:52px">
    ${rows.map((n) => {
      const d = drivers.get(n) || { acr: n, color: '#888' };
      return `<div style="display:flex;align-items:center;height:24px;margin:3px 0;position:relative">
        <span style="position:absolute;left:-52px;width:46px;font-weight:800;font-size:13px;border-left:3px solid ${d.color};padding-left:6px">${esc(d.acr)}</span>
        <div style="position:relative;flex:1;height:18px;background:var(--surface-2);border-radius:4px">
        ${byD.get(n).sort((a, b) => a.stint_number - b.stint_number).map((s) => {
          const a = (s.lap_start || 1) - 1, b = s.lap_end || maxLap;
          const c = TYRE_COLORS[s.compound] || '#666';
          return `<div title="${esc(s.compound || '?')} · voltas ${a + 1}–${b}${s.tyre_age_at_start ? ' · usado (' + s.tyre_age_at_start + ' voltas)' : ' · novo'}" style="position:absolute;top:0;bottom:0;left:${(a / maxLap) * 100}%;width:calc(${((b - a) / maxLap) * 100}% - 2px);background:${c};border-radius:4px;opacity:${s.tyre_age_at_start ? .65 : .95};display:flex;align-items:center;justify-content:center;font:800 11px var(--mono);color:#000;overflow:hidden">${b - a >= 4 ? tyreLetter(s.compound) + ' ' + (b - a) : ''}</div>`;
        }).join('')}</div></div>`;
    }).join('')}
    <div style="position:relative;height:18px;margin-top:4px;font:11px var(--mono);color:var(--muted)">${ticks.map((l) => `<span style="position:absolute;left:${(l / maxLap) * 100}%;transform:translateX(-50%)">${l}</span>`).join('')}</div>
  </div>
  <div class="legend">${['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'].map((c) => `<span><i style="background:${TYRE_COLORS[c]};height:10px;width:10px;border-radius:50%"></i>${{ SOFT: 'Macio', MEDIUM: 'Médio', HARD: 'Duro', INTERMEDIATE: 'Intermédio', WET: 'Chuva' }[c]}</span>`).join('')}<span class="muted">Mais claro = pneu usado</span></div>`;
}

/** laps: [{driver_number, lap_number, lap_duration, is_pit_out_lap}] */
export function lapTimeChart(el, laps, drivers, { order = null, filterOutliers = true, height = 360 } = {}) {
  const byD = new Map();
  for (const l of laps) { if (!l.lap_duration) continue; if (!byD.has(l.driver_number)) byD.set(l.driver_number, []); byD.get(l.driver_number).push(l); }
  const all = [...byD.values()].flat().map((l) => l.lap_duration).sort((a, b) => a - b);
  const best = all[0] || 0;
  const cut = filterOutliers ? best * 1.12 : Infinity;
  const nums = order || [...byD.keys()];
  const series = nums.filter((n) => byD.has(n)).map((n, i) => {
    const d = drivers.get(n) || { acr: String(n), color: '#888' };
    const L = byD.get(n).sort((a, b) => a.lap_number - b.lap_number);
    return { name: d.acr, color: d.color, xs: L.map((l) => l.lap_number), ys: L.map((l) => (l.lap_duration <= cut && !l.is_pit_out_lap ? l.lap_duration : null)), dots: true, width: 1.4, hidden: i >= 6 };
  });
  if (!series.length) { el.innerHTML = '<p class="muted">Sem tempos por volta.</p>'; return null; }
  return new LineChart(el, series, { height, yLabel: 'Tempo de volta', xFormat: (v) => `V${Math.round(v)}`, yFormat: (v) => fmt.lap(v), sortTip: true, invertY: false, tipTitle: (x) => `Volta ${Math.round(x)}` });
}

/** positionsByLap: Map num -> [{lap, pos}] */
export function positionChart(el, positionsByLap, drivers, order, height = 420) {
  const series = order.filter((n) => positionsByLap.has(n)).map((n) => {
    const d = drivers.get(n) || { acr: String(n), color: '#888' };
    const P = positionsByLap.get(n);
    return { name: d.acr, color: d.color, xs: P.map((p) => p.lap), ys: P.map((p) => p.pos), width: 2 };
  });
  const seen = new Map();
  for (const s of series) { const k = s.color; s.dash = seen.has(k) ? [5, 4] : null; seen.set(k, 1); }
  return new LineChart(el, series, { height, yLabel: 'Posição', invertY: true, yMin: 1, yMax: Math.max(10, series.length), yTicks: [1, 5, 10, 15, 20], xFormat: (v) => `V${Math.round(v)}`, yFormat: (v) => `P${Math.round(v)}`, sortTip: true, tipTitle: (x) => `Volta ${Math.round(x)}` });
}

export function driverMapFromOpenF1(list) {
  const m = new Map();
  for (const d of list) m.set(d.driver_number, { num: d.driver_number, acr: d.name_acronym || String(d.driver_number), name: d.full_name || d.broadcast_name, team: d.team_name, color: hex(d.team_colour || '888888'), headshot: d.headshot_url, country: d.country_code });
  return m;
}
