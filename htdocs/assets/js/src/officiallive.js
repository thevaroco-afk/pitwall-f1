// =========================================================
// CRONOMETRAGEM OFICIAL EM DIRECTO — feed público da F1 (sem conta)
// O Worker (Durable Object LiveTiming) liga-se a livetiming.formula1.com
// e reenvia os dados por WebSocket para /api/live/ws.
// =========================================================
import { $, esc, fmt } from './core.js';

const ST = { state: {}, status: null, ws: null, tries: 0, el: null, timer: null, dirty: false, prevPos: new Map(), lastRC: 0 };

// mesma regra de fusão do Worker: objectos fundidos, arrays por índice
function merge(target, delta) {
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
const vals = (o) => (o == null ? [] : Array.isArray(o) ? o.filter(Boolean) : Object.keys(o).sort((a, b) => a - b).map((k) => o[k]).filter(Boolean));

/** "1:23.456" / "23.456" -> segundos */
function secs(s) {
  if (!s || typeof s !== 'string') return null;
  const p = s.split(':').map(Number);
  if (p.some(isNaN)) return null;
  return p.reduce((a, x) => a * 60 + x, 0);
}

const TRACK = {
  1: ['GREEN', 'Pista livre'], 2: ['YELLOW', 'Bandeira amarela'], 3: ['YELLOW', 'Bandeira amarela'], 4: ['SC', 'Safety Car'],
  5: ['RED', 'Bandeira vermelha'], 6: ['VSC', 'Virtual Safety Car'], 7: ['VSC', 'VSC a terminar'],
};
const STATUS_PT = { Inactive: 'Por começar', Started: 'A decorrer', Aborted: 'Interrompida', Finished: 'Terminada', Finalised: 'Terminada', Ends: 'Terminada' };
const NAME_PT = { 'Practice 1': 'Treinos Livres 1', 'Practice 2': 'Treinos Livres 2', 'Practice 3': 'Treinos Livres 3', Qualifying: 'Qualificação', 'Sprint Qualifying': 'Qualificação Sprint', 'Sprint Shootout': 'Sprint Shootout', Sprint: 'Sprint', Race: 'Corrida' };
const TYPE_PT = { Practice: 'Treinos Livres', Qualifying: 'Qualificação', Race: 'Corrida' };

export function mountOfficialLive(el) {
  ST.el = el;
  if (location.protocol === 'file:') return; // precisa do Worker
  connect();
  setInterval(() => { if (ST.dirty) { ST.dirty = false; render(); } else renderClock(); }, 500);
}

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live/ws`;
  let ws;
  try { ws = new WebSocket(url); } catch { return retry(); }
  ST.ws = ws;
  ws.onopen = () => { ST.tries = 0; };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'snap') { ST.state = m.state || {}; ST.status = m.status; }
    else if (m.t === 'd') { for (const [topic, data] of m.d) ST.state[topic] = merge(ST.state[topic], data); }
    else if (m.t === 'status') ST.status = m.status;
    ST.dirty = true;
  };
  ws.onclose = () => { ST.ws = null; retry(); };
  ws.onerror = () => { try { ws.close(); } catch { /* */ } };
}
function retry() {
  ST.tries++;
  clearTimeout(ST.timer);
  ST.timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(ST.tries, 5)));
}

function isLive() {
  const s = ST.state.SessionStatus?.Status;
  const hb = Date.parse(ST.state.Heartbeat?.Utc || '');
  return (s === 'Started' || s === 'Aborted') || (hb && Date.now() - hb < 120_000 && s !== 'Finalised' && s !== 'Ends');
}

function remaining() {
  const c = ST.state.ExtrapolatedClock;
  if (!c?.Remaining) return null;
  let r = secs(c.Remaining);
  if (r == null) return null;
  if (c.Extrapolating) r -= (Date.now() - Date.parse(c.Utc)) / 1000;
  r = Math.max(0, Math.round(r));
  const h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), s = r % 60;
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
}
function renderClock() { const el = ST.el?.querySelector('#olClock'); if (el) el.textContent = remaining() ?? ''; }

function render() {
  const el = ST.el;
  if (!el) return;
  const S = ST.state;
  const drivers = S.DriverList || {};
  const lines = S.TimingData?.Lines || {};
  const nums = Object.keys(lines).filter((n) => drivers[n] || lines[n]);
  if (!nums.length) {
    const st = ST.status;
    el.innerHTML = st?.upstream === 'error'
      ? `<p class="muted" style="font-size:13px">Cronometragem oficial F1: sem ligação neste momento (${esc(st.error || 'erro')}). A tentar de novo…</p>`
      : `<p class="muted" style="font-size:13px">Cronometragem oficial F1: ${st?.upstream === 'connected' ? 'ligado, à espera de dados da sessão.' : 'a ligar…'}</p>`;
    return;
  }
  const info = S.SessionInfo || {};
  const type = info.Type || '';
  const isRace = /race|sprint/i.test(type) && !/qualifying|shootout/i.test(info.Name || '');
  const isQuali = /qualifying|shootout/i.test(type + ' ' + (info.Name || ''));
  const part = S.TimingData?.SessionPart; // Q1/Q2/Q3
  const live = isLive();
  const ts = TRACK[S.TrackStatus?.Status] || TRACK[1];
  const statusTxt = STATUS_PT[S.SessionStatus?.Status] || S.SessionStatus?.Status || '';
  const lapCount = S.LapCount?.CurrentLap ? `VOLTA ${S.LapCount.CurrentLap}${S.LapCount.TotalLaps ? '/' + S.LapCount.TotalLaps : ''}` : '';
  const app = S.TimingAppData?.Lines || {};
  const stats = S.TimingStats?.Lines || {};

  const rows = nums.map((n) => ({ n, l: lines[n], d: drivers[n] || {}, pos: +(lines[n].Position || lines[n].Line || 99) }))
    .sort((a, b) => a.pos - b.pos);

  const body = rows.map(({ n, l, d, pos }, i) => {
    const color = d.TeamColour ? `#${d.TeamColour}` : '#888';
    const stints = vals(app[n]?.Stints);
    const st = stints.at(-1);
    const tyre = st?.Compound ? `<span class="tyre ${esc(st.Compound)}" title="${esc(st.Compound)} · ${st.TotalLaps ?? 0} voltas${st.New === 'false' ? ' (usado)' : ''}">${esc(st.Compound[0])}</span><small class="muted">${st.TotalLaps ?? ''}</small>` : '';
    let gap = '', sub = '';
    if (isRace) {
      const iv = l.IntervalToPositionAhead?.Value ?? '';
      const g = l.GapToLeader ?? '';
      gap = i === 0 ? (S.LapCount?.CurrentLap ? `Volta ${S.LapCount.CurrentLap}` : 'Líder') : iv || g;
      sub = i > 1 && iv && g && g !== iv ? g : '';
    } else {
      const best = isQuali ? (vals(l.BestLapTimes)[(part || 1) - 1]?.Value || l.BestLapTime?.Value) : l.BestLapTime?.Value;
      gap = best || '—';
      const diff = isQuali ? vals(l.Stats)[(part || 1) - 1]?.TimeDiffToFastest : l.TimeDiffToFastest;
      sub = i > 0 && diff ? diff : '';
    }
    const last = l.LastLapTime || {};
    const lastColor = last.OverallFastest ? 'var(--purple)' : last.PersonalFastest ? 'var(--green)' : 'inherit';
    const sectors = vals(l.Sectors).slice(0, 3).map((s) => {
      const c = s.OverallFastest ? 'var(--purple)' : s.PersonalFastest ? 'var(--green)' : s.Value ? 'var(--yellow)' : 'var(--surface-3)';
      return `<i title="${esc(s.Value || '')}" style="background:${c}"></i>`;
    }).join('');
    const flags = l.Retired ? '<span class="chip red" style="padding:1px 7px">DNF</span>'
      : l.Stopped ? '<span class="chip red" style="padding:1px 7px">PARADO</span>'
      : live && l.InPit ? '<span class="chip yellow" style="padding:1px 7px">BOX</span>'
      : live && l.PitOut ? '<span class="chip blue" style="padding:1px 7px">SAÍDA</span>'
      : l.KnockedOut ? '<span class="chip" style="padding:1px 7px">ELIM.</span>' : '';
    const pp = ST.prevPos.get(n);
    const mv = pp && pp !== pos ? (pos < pp ? 'up' : 'down') : '';
    ST.prevPos.set(n, pos);
    return `<div class="row ${mv}" title="${esc(d.FullName || '')} · ${esc(d.TeamName || '')}">
      <span class="p">${pos < 99 ? pos : ''}</span><span class="team-bar" style="background:${color};height:20px"></span>
      <span class="ab">${esc(d.Tla || n)}</span>
      <span class="gp">${flags || esc(gap)}${sub && !flags ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="gap"><span style="color:${lastColor}">${esc(last.Value || '')}</span></span>
      <span class="sec">${sectors}</span>
      <span class="ty">${tyre}</span>
      <span class="pits mono muted">${l.NumberOfPitStops ? l.NumberOfPitStops + '×' : ''}</span>
    </div>`;
  }).join('');

  const rc = vals(S.RaceControlMessages?.Messages).slice(-12).reverse();
  const w = S.WeatherData;
  const weather = w ? [[`${w.AirTemp}°`, 'Ar'], [`${w.TrackTemp}°`, 'Pista'], [`${w.Humidity}%`, 'Humidade'], [`${w.WindSpeed} m/s`, 'Vento'], [+w.Rainfall ? '🌧 Sim' : '☀ Não', 'Chuva']]
    .map(([v, l]) => `<div class="w"><b>${esc(v)}</b><span>${l}</span></div>`).join('') : '';

  el.innerHTML = `
    <div class="card">
      <div class="row-flex mb" style="justify-content:space-between">
        <div class="row-flex">
          <div class="card-title" style="margin:0">Cronometragem oficial F1</div>
          ${live ? '<span class="chip live">AO VIVO</span>' : `<span class="chip">${esc(statusTxt || 'Sem sessão em curso')}</span>`}
        </div>
        <div class="row-flex">
          <span class="flag-banner flag-${ts[0]}">${ts[1]}</span>
          ${lapCount ? `<span class="lapbig">${lapCount}</span>` : ''}
          <span class="lapbig" id="olClock">${remaining() ?? ''}</span>
        </div>
      </div>
      <h3 style="font-size:18px;margin:0 0 10px">${esc(info.Meeting?.Name || '')} · ${esc(NAME_PT[info.Name] || info.Name || TYPE_PT[info.Type] || '')}${part && isQuali ? ` · Q${part}` : ''}</h3>
      <div class="ol-grid">
        <div class="timing ol">
          <div class="row hd"><span>P</span><span></span><span>Piloto</span><span>${isRace ? 'Intervalo' : 'Melhor volta'}</span><span style="text-align:right">Última</span><span>Sect.</span><span>Pneu</span><span>Box</span></div>
          ${body}
        </div>
        <div>
          <div class="card-title">Direcção de corrida</div>
          <div class="feed">${rc.map((m) => `<div class="it"><span class="tm">${esc((m.Utc ? fmt.clock(Date.parse(m.Utc + (/Z$/.test(m.Utc) ? '' : 'Z'))) : '').slice(0, 8))}${m.Lap ? `<br>V${m.Lap}` : ''}</span><span>${esc(m.Message)}</span></div>`).join('') || '<p class="muted">Sem mensagens.</p>'}</div>
          ${weather ? `<div class="card-title mt">Meteorologia</div><div class="weather">${weather}</div>` : ''}
        </div>
      </div>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">Dados oficiais da Formula 1 (livetiming.formula1.com), em directo e sem conta. O mapa com os carros e a telemetria em directo exigem F1 TV e não estão incluídos.</p>
    </div>`;
}
