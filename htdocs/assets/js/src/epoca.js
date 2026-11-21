import { init, $, $$, esc, erg, ergAll, fmt, raceDate, flagCountry, flagNat, teamColor, skeleton, errorBox, openModal, tabs, qs, setQs, cumulativePoints, dashTeammates, weekendSessions } from './core.js';
import { LineChart } from './charts.js';

const NOW_Y = new Date().getFullYear();
let Y = +qs('ano', NOW_Y);
const cache = {};
const once = (k, fn) => (cache[k] ??= fn());

const data = {
  schedule: () => once('s' + Y, () => erg(`${Y}`, {}, 3600).then((d) => d.RaceTable.Races)),
  winners: () => once('w' + Y, () => ergAll(`${Y}/results/1`, Y < NOW_Y ? 86400 * 7 : 900)),
  results: () => once('r' + Y, () => ergAll(`${Y}/results`, Y < NOW_Y ? 86400 * 7 : 900)),
  sprints: () => once('sp' + Y, () => (Y >= 2021 ? ergAll(`${Y}/sprint`, Y < NOW_Y ? 86400 * 7 : 900) : Promise.resolve([]))),
  quali: () => once('q' + Y, () => (Y >= 1994 ? ergAll(`${Y}/qualifying`, Y < NOW_Y ? 86400 * 7 : 900) : Promise.resolve([]))),
  dStand: () => once('ds' + Y, () => erg(`${Y}/driverStandings`, {}, 900).then((d) => d.StandingsTable.StandingsLists[0]?.DriverStandings || [])),
  cStand: () => once('cs' + Y, () => (Y >= 1958 ? erg(`${Y}/constructorStandings`, {}, 900).then((d) => d.StandingsTable.StandingsLists[0]?.ConstructorStandings || []) : Promise.resolve([]))),
};

function driverCell(d, c, extra = '') {
  return `<div class="driver-cell"><span class="team-bar" style="background:${teamColor(c?.constructorId, c?.name)}"></span><span class="name">${flagNat(d.nationality)} ${esc(d.givenName)} <b>${esc(d.familyName)}</b><small>${esc(c?.name || '')}${extra}</small></span></div>`;
}

// ---------- Calendário ----------
async function renderCalendar(el) {
  const [races, winners] = await Promise.all([data.schedule(), data.winners().catch(() => [])]);
  const wmap = new Map(winners.map((r) => [r.round, r.Results[0]]));
  const now = Date.now();
  const nextR = races.find((r) => raceDate(r).getTime() + 3 * 3600e3 > now);
  el.innerHTML = `<div class="cal-grid">${races.map((r) => {
    const d = raceDate(r);
    const w = wmap.get(r.round);
    const done = !!w || d.getTime() < now - 3 * 3600e3;
    const fp1 = raceDate(r, 'FirstPractice');
    const sprint = r.Sprint ? '<span class="chip blue">Sprint</span>' : '';
    return `<div class="race-card ${done ? 'done' : ''} ${r === nextR ? 'next' : ''}" data-round="${r.round}">
      <div class="rnd"><span>Ronda ${r.round}</span>${r === nextR ? '<span class="chip red">Próxima</span>' : sprint}</div>
      <div class="flag">${flagCountry(r.Circuit.Location.country)}</div>
      <h3>${esc(r.raceName)}</h3>
      <div class="loc">${esc(r.Circuit.circuitName)}</div>
      <div class="dt">${fp1 ? esc(fmt.dayMonth(fp1)) + ' – ' : ''}${esc(fmt.date(d))}</div>
      ${w ? `<div class="win"><span class="team-bar" style="height:16px;background:${teamColor(w.Constructor.constructorId)}"></span>🏆 <b>${esc(w.Driver.givenName)} ${esc(w.Driver.familyName)}</b></div>` : ''}
    </div>`;
  }).join('')}</div>`;
  el.onclick = (e) => {
    const c = e.target.closest('.race-card');
    if (c) raceModal(races.find((r) => r.round === c.dataset.round));
  };
}

// ---------- Classificações ----------
async function renderDrivers(el) {
  const L = await data.dStand();
  if (!L.length) { el.innerHTML = errorBox('Sem classificação para esta época.'); return; }
  const leader = +L[0].points;
  el.innerHTML = `<div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th>Pos</th><th>Piloto</th><th class="r">Vitórias</th><th class="r">Pontos</th><th class="r">Diferença</th></tr></thead><tbody>
    ${L.map((x) => `<tr class="clickable" data-id="${esc(x.Driver.driverId)}"><td class="pos ${+x.position <= 3 ? 'p' + x.position : ''}">${x.positionText}</td><td>${driverCell(x.Driver, x.Constructors.at(-1), x.Driver.permanentNumber ? ' · #' + x.Driver.permanentNumber : '')}</td><td class="r mono">${x.wins}</td><td class="r mono"><b>${fmt.pts(+x.points)}</b></td><td class="r mono muted">${x.position === '1' ? '—' : '-' + fmt.pts(leader - x.points)}</td></tr>`).join('')}
  </tbody></table></div></div>`;
  el.onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.href = `pilotos.html?id=${tr.dataset.id}`; };
}
async function renderConstructors(el) {
  const L = await data.cStand();
  if (!L.length) { el.innerHTML = errorBox('Não existia campeonato de construtores nesta época (começou em 1958).'); return; }
  const max = +L[0].points || 1;
  el.innerHTML = `<div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th>Pos</th><th>Equipa</th><th>Pontos</th><th class="r">Vitórias</th><th class="r">Pontos</th></tr></thead><tbody>
    ${L.map((x) => { const c = teamColor(x.Constructor.constructorId, x.Constructor.name); return `<tr><td class="pos ${+x.position <= 3 ? 'p' + x.position : ''}">${x.positionText}</td><td><div class="driver-cell"><span class="team-bar" style="background:${c}"></span><span class="name"><b>${esc(x.Constructor.name)}</b><small>${flagNat(x.Constructor.nationality)} ${esc(x.Constructor.nationality)}</small></span></div></td><td style="width:40%"><div class="bar-row" style="grid-template-columns:1fr"><span class="bar"><i style="width:${(x.points / max) * 100}%;background:${c}"></i></span></div></td><td class="r mono">${x.wins}</td><td class="r mono"><b>${fmt.pts(+x.points)}</b></td></tr>`; }).join('')}
  </tbody></table></div></div>`;
}

// ---------- Evolução ----------
async function renderEvolution(el) {
  el.innerHTML = `<div class="card"><div class="row-flex mb"><div class="tabs" id="evoMode"><button class="tab active" data-tab="driver">Pilotos</button><button class="tab" data-tab="constructor">Construtores</button></div><div class="tabs" id="evoKind"><button class="tab active" data-tab="pts">Pontos acumulados</button><button class="tab" data-tab="pos">Posição</button></div><span class="muted" style="font-size:13px">Arraste para fazer zoom · duplo-clique para repor · clique na legenda para esconder</span></div><div id="evoChart">${skeleton(8)}</div></div>`;
  const [races, sprints, sched] = await Promise.all([data.results(), data.sprints(), data.schedule()]);
  const names = new Map(sched.map((r) => [+r.round, r.raceName.replace(' Grand Prix', '')]));
  let mode = 'driver', kind = 'pts';
  const draw = () => {
    const { rounds, series } = cumulativePoints(races, sprints, mode);
    let S = series.slice(0, mode === 'driver' ? 12 : 11).map((s) => ({ name: s.name, color: s.color, xs: rounds, ys: s.data, width: 2.2 }));
    if (kind === 'pos') {
      // posição no campeonato depois de cada ronda
      const all = series;
      S = S.map((s) => ({ ...s, ys: rounds.map((_, i) => 1 + all.filter((o) => o.data[i] > all.find((a) => a.name === s.name).data[i]).length), dots: true }));
    }
    dashTeammates(S);
    new LineChart($('#evoChart'), S, {
      height: 420, yLabel: kind === 'pts' ? 'Pontos' : 'Posição', invertY: kind === 'pos', yMin: kind === 'pos' ? 1 : 0, yMax: kind === 'pos' ? Math.min(series.length, 15) : undefined,
      xFormat: (v) => `R${Math.round(v)}`, yFormat: (v) => (kind === 'pos' ? `P${Math.round(v)}` : fmt.pts(v)), sortTip: true,
      tipTitle: (x) => `R${Math.round(x)} · ${names.get(Math.round(x)) || ''}`,
    });
  };
  draw();
  tabs($('#evoMode'), (t) => { mode = t; draw(); });
  tabs($('#evoKind'), (t) => { kind = t; draw(); });
}

// ---------- Estatísticas ----------
function topBars(title, counts, colorOf, unit = '') {
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = list[0]?.[1] || 1;
  return `<div class="card"><div class="card-title">${title}</div>${list.length ? list.map(([k, v], i) => `<div class="bar-row"><span class="pos mono">${i + 1}</span><span class="nm">${esc(k)}</span><span class="bar"><i style="width:${(v / max) * 100}%;background:${colorOf(k)}"></i></span><span class="n">${fmt.num(v, unit === '%' ? 0 : 0)}${unit}</span></div>`).join('') : '<p class="muted">Sem dados.</p>'}</div>`;
}
async function renderStats(el) {
  el.innerHTML = skeleton(10);
  const [races, quali] = await Promise.all([data.results(), data.quali()]);
  const col = new Map();
  const inc = (m, k, v = 1) => m.set(k, (m.get(k) || 0) + v);
  const wins = new Map(), pods = new Map(), poles = new Map(), fls = new Map(), dnf = new Map(), gained = new Map(), lapsLed = new Map(), teamWins = new Map(), pts = new Map();
  for (const r of races) {
    for (const x of r.Results) {
      const n = `${x.Driver.givenName[0]}. ${x.Driver.familyName}`;
      col.set(n, teamColor(x.Constructor.constructorId, x.Constructor.name));
      col.set(x.Constructor.name, teamColor(x.Constructor.constructorId, x.Constructor.name));
      if (x.position === '1') { inc(wins, n); inc(teamWins, x.Constructor.name); }
      if (+x.position <= 3) inc(pods, n);
      if (x.FastestLap?.rank === '1') inc(fls, n);
      if (!/Finished|\+\d+ Laps?|Lapped/.test(x.status)) inc(dnf, n);
      if (+x.grid > 0 && /^\d+$/.test(x.positionText)) inc(gained, n, +x.grid - +x.position);
      inc(pts, n, 0);
    }
  }
  for (const q of quali) { const x = q.QualifyingResults?.find((r) => r.position === '1'); if (x) inc(poles, `${x.Driver.givenName[0]}. ${x.Driver.familyName}`); }
  const c = (k) => col.get(k) || '#888';
  const gainedPos = new Map([...gained].filter(([, v]) => v > 0));
  el.innerHTML = `<div class="grid g-3">
    ${topBars('Vitórias', wins, c)}${topBars('Pódios', pods, c)}${topBars('Pole positions', poles, c)}
    ${topBars('Voltas mais rápidas', fls, c)}${topBars('Posições ganhas (grelha → final)', gainedPos, c)}${topBars('Abandonos / não classificados', dnf, c)}
    ${topBars('Vitórias por equipa', teamWins, c)}
  </div>`;
}

// ---------- Duelos entre colegas ----------
async function renderH2H(el) {
  el.innerHTML = skeleton(10);
  const [races, quali] = await Promise.all([data.results(), data.quali()]);
  const pairs = new Map();
  const key = (r, a, b) => `${r.Constructor.constructorId}|${[a, b].sort().join('|')}`;
  const ensure = (k, team, a, b) => { if (!pairs.has(k)) pairs.set(k, { team, a, b, race: { [a.driverId]: 0, [b.driverId]: 0 }, quali: { [a.driverId]: 0, [b.driverId]: 0 }, pts: { [a.driverId]: 0, [b.driverId]: 0 } }); return pairs.get(k); };
  const byTeam = (list) => { const m = new Map(); for (const x of list) { const t = x.Constructor.constructorId; if (!m.has(t)) m.set(t, []); m.get(t).push(x); } return m; };
  for (const r of races) {
    for (const [, xs] of byTeam(r.Results)) {
      if (xs.length !== 2) continue;
      const [a, b] = xs; const p = ensure(key(a, a.Driver.driverId, b.Driver.driverId), a.Constructor, a.Driver, b.Driver);
      p.race[(+a.position < +b.position ? a : b).Driver.driverId]++;
      p.pts[a.Driver.driverId] += +a.points; p.pts[b.Driver.driverId] += +b.points;
    }
  }
  for (const q of quali) {
    for (const [, xs] of byTeam(q.QualifyingResults || [])) {
      if (xs.length !== 2) continue;
      const [a, b] = xs; const k = key(a, a.Driver.driverId, b.Driver.driverId);
      const p = pairs.get(k) || ensure(k, a.Constructor, a.Driver, b.Driver);
      p.quali[(+a.position < +b.position ? a : b).Driver.driverId]++;
    }
  }
  const list = [...pairs.values()].filter((p) => p.race[p.a.driverId] + p.race[p.b.driverId] >= 3);
  if (!list.length) { el.innerHTML = errorBox('Sem dados suficientes para duelos nesta época.'); return; }
  const row = (label, A, B, col) => {
    const t = A + B || 1;
    return `<div style="display:grid;grid-template-columns:40px 1fr 40px;gap:10px;align-items:center;margin:6px 0"><b class="mono" style="text-align:right">${fmt.pts(A)}</b><div><div class="muted" style="font-size:11.5px;text-align:center;text-transform:uppercase;letter-spacing:.08em;font-weight:700">${label}</div><div style="display:flex;height:8px;border-radius:5px;overflow:hidden;background:var(--surface-3)"><i style="width:${(A / t) * 100}%;background:${col}"></i><i style="width:${(B / t) * 100}%;background:${col};opacity:.4"></i></div></div><b class="mono">${fmt.pts(B)}</b></div>`;
  };
  el.innerHTML = `<div class="grid g-3">${list.map((p) => {
    const col = teamColor(p.team.constructorId, p.team.name);
    return `<div class="card"><div class="card-title" style="color:${col}">${esc(p.team.name)}</div>
      <div style="display:flex;justify-content:space-between;font-weight:800;font-size:17px"><span>${flagNat(p.a.nationality)} ${esc(p.a.familyName)}</span><span>${esc(p.b.familyName)} ${flagNat(p.b.nationality)}</span></div>
      ${row('Corrida', p.race[p.a.driverId], p.race[p.b.driverId], col)}${row('Qualificação', p.quali[p.a.driverId], p.quali[p.b.driverId], col)}${row('Pontos', p.pts[p.a.driverId], p.pts[p.b.driverId], col)}
    </div>`;
  }).join('')}</div>`;
}

// ---------- Detalhe de corrida ----------
export async function raceModal(r) {
  const d = raceDate(r);
  const m = openModal(`${flagCountry(r.Circuit.Location.country)} ${esc(r.raceName)}`, `Ronda ${r.round} · ${esc(fmt.date(d))} · ${esc(r.Circuit.circuitName)}`, skeleton(8));
  const y = r.season;
  const [res, q, sp, pits] = await Promise.all([
    erg(`${y}/${r.round}/results`, {}, 3600).then((x) => x.RaceTable.Races[0]).catch(() => null),
    erg(`${y}/${r.round}/qualifying`, {}, 3600).then((x) => x.RaceTable.Races[0]).catch(() => null),
    r.Sprint ? erg(`${y}/${r.round}/sprint`, {}, 3600).then((x) => x.RaceTable.Races[0]).catch(() => null) : null,
    +y >= 2012 ? erg(`${y}/${r.round}/pitstops`, {}, 3600).then((x) => x.RaceTable.Races[0]).catch(() => null) : null,
  ]);
  const links = +y >= 2023 ? `<div class="row-flex mb"><a class="btn small primary" href="aovivo.html?d=${r.date}">▶ Replay da corrida</a><a class="btn small" href="telemetria.html?d=${r.date}">Telemetria</a><a class="btn small" href="circuitos.html?c=${r.Circuit.circuitId}">Circuito</a></div>` : `<div class="row-flex mb"><a class="btn small" href="circuitos.html?c=${r.Circuit.circuitId}">Circuito</a></div>`;
  if (!res) {
    const sess = weekendSessions(r);
    m.el.innerHTML = links + `<div class="card-title">Horários (hora local)</div><div class="sessions-list">${sess.map((s) => `<div class="s"><span class="nm">${esc(s.name)}</span><span class="d">${esc(fmt.weekday(s.date))}</span><span class="h">${esc(fmt.time(s.date))}</span></div>`).join('')}</div>`;
    return;
  }
  const tabsHtml = `<div class="tabs mb" id="rmTabs"><button class="tab active" data-tab="race">Corrida</button>${q ? '<button class="tab" data-tab="quali">Qualificação</button>' : ''}${sp ? '<button class="tab" data-tab="sprint">Sprint</button>' : ''}${pits?.PitStops?.length ? '<button class="tab" data-tab="pits">Paragens</button>' : ''}</div>`;
  const resultTable = (rows) => `<div class="table-wrap"><table class="t"><thead><tr><th>Pos</th><th>Piloto</th><th class="r">Grelha</th><th class="r">+/-</th><th class="r">Voltas</th><th>Tempo / Estado</th><th class="r">Pts</th></tr></thead><tbody>${rows.map((x) => {
    const delta = +x.grid > 0 && /^\d+$/.test(x.positionText) ? +x.grid - +x.position : null;
    const fl = x.FastestLap?.rank === '1';
    return `<tr><td class="pos ${+x.position <= 3 ? 'p' + x.position : ''}">${esc(x.positionText)}</td><td>${driverCell(x.Driver, x.Constructor)}</td><td class="r mono">${x.grid === '0' ? 'Pit' : x.grid}</td><td class="r mono" style="color:${delta > 0 ? 'var(--green)' : delta < 0 ? 'var(--red)' : 'var(--muted)'}">${delta == null ? '' : delta > 0 ? '▲' + delta : delta < 0 ? '▼' + -delta : '='}</td><td class="r mono">${x.laps}</td><td class="mono" style="font-size:13.5px">${esc(x.Time?.time || x.status)}${fl ? ' <span class="chip" style="background:rgba(177,76,255,.2);color:#d39bff">VMR ' + esc(x.FastestLap.Time?.time || '') + '</span>' : ''}</td><td class="r mono"><b>${x.points}</b></td></tr>`;
  }).join('')}</tbody></table></div>`;
  const qTable = () => `<div class="table-wrap"><table class="t"><thead><tr><th>Pos</th><th>Piloto</th><th class="r">Q1</th><th class="r">Q2</th><th class="r">Q3</th></tr></thead><tbody>${q.QualifyingResults.map((x) => `<tr><td class="pos ${+x.position <= 3 ? 'p' + x.position : ''}">${x.position}</td><td>${driverCell(x.Driver, x.Constructor)}</td><td class="r mono">${esc(x.Q1 || '')}</td><td class="r mono">${esc(x.Q2 || '')}</td><td class="r mono"><b>${esc(x.Q3 || '')}</b></td></tr>`).join('')}</tbody></table></div>`;
  const pitTable = () => {
    const drivers = new Map(res.Results.map((x) => [x.Driver.driverId, x]));
    return `<div class="table-wrap"><table class="t"><thead><tr><th>Piloto</th><th class="r">Volta</th><th class="r">Paragem</th><th class="r">Duração</th></tr></thead><tbody>${[...pits.PitStops].sort((a, b) => +a.duration - +b.duration).map((p) => { const x = drivers.get(p.driverId); return `<tr><td>${x ? driverCell(x.Driver, x.Constructor) : esc(p.driverId)}</td><td class="r mono">${p.lap}</td><td class="r mono">${p.stop}</td><td class="r mono"><b>${esc(p.duration)}</b>s</td></tr>`; }).join('')}</tbody></table></div><p class="muted mt-s" style="font-size:13px">Duração = tempo total no pit lane, ordenado do mais rápido.</p>`;
  };
  m.el.innerHTML = links + tabsHtml + `<div id="rmBody">${resultTable(res.Results)}</div>`;
  tabs($('#rmTabs'), (t) => {
    $('#rmBody').innerHTML = t === 'race' ? resultTable(res.Results) : t === 'quali' ? qTable() : t === 'sprint' ? resultTable(sp.SprintResults) : pitTable();
  });
}

// ---------- Página ----------
init(async () => {
  const app = $('#app');
  const years = Array.from({ length: NOW_Y - 1949 }, (_, i) => NOW_Y - i);
  app.innerHTML = `
    <section class="page-hero container">
      <h1>Época <em id="yTitle">${Y}</em></h1>
      <p>Calendário, classificações, evolução do campeonato, estatísticas e duelos entre colegas de equipa. Clique numa corrida para ver resultados, qualificação e paragens nas boxes.</p>
      <div class="row-flex mt">
        <select class="select" id="ySel" aria-label="Época">${years.map((y) => `<option ${y === Y ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <div class="tabs" id="tabs">
          <button class="tab" data-tab="calendario">Calendário</button><button class="tab" data-tab="pilotos">Pilotos</button><button class="tab" data-tab="construtores">Construtores</button>
          <button class="tab" data-tab="evolucao">Evolução</button><button class="tab" data-tab="stats">Estatísticas</button><button class="tab" data-tab="duelos">Duelos</button>
        </div>
      </div>
    </section>
    <section class="section container" style="padding-top:18px"><div id="view"></div></section>`;
  const renderers = { calendario: renderCalendar, pilotos: renderDrivers, construtores: renderConstructors, evolucao: renderEvolution, stats: renderStats, duelos: renderH2H };
  let cur = qs('tab', 'calendario');
  if (!renderers[cur]) cur = 'calendario';
  const show = async (t) => {
    cur = t;
    $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    setQs({ tab: t === 'calendario' ? null : t, ano: Y === NOW_Y ? null : Y });
    const v = $('#view');
    v.innerHTML = `<div class="card">${skeleton(10)}</div>`;
    try { await renderers[t](v); } catch (e) { console.error(e); v.innerHTML = `<div class="card">${errorBox('Não foi possível carregar estes dados. Tente novamente dentro de momentos.', e.message)}</div>`; }
  };
  tabs($('#tabs'), show);
  $('#ySel').addEventListener('change', (e) => { Y = +e.target.value; $('#yTitle').textContent = Y; show(cur); });
  await show(cur);
  const rnd = qs('ronda');
  if (rnd) { const races = await data.schedule(); const r = races.find((x) => x.round === rnd); if (r) raceModal(r); }
});
