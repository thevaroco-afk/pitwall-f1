// =========================================================
// PILOTOS — pesquisa, perfil de carreira e comparação
// =========================================================
import { init, $, $$, esc, getLocal, getJSON, erg, ergAll, fmt, flagNat, teamColor, skeleton, errorBox, qs, setQs } from './core.js';
import { CONFIG } from './config.js';
import { LineChart } from './charts.js';

const H = CONFIG.historyData;
const NOW_Y = new Date().getFullYear();
let ALL = null; // drivers.json (Kaggle) ou lista Jolpica

async function allDrivers() {
  if (ALL) return ALL;
  const k = await getLocal(`${H}/drivers.json`);
  if (k?.length) { ALL = { kaggle: true, list: k }; return ALL; }
  const list = await ergAll('drivers', 86400 * 7, 'DriverTable', 'Drivers');
  ALL = { kaggle: false, list: list.map((d) => ({ id: d.driverId, name: `${d.givenName} ${d.familyName}`, nat: d.nationality, dob: d.dateOfBirth, code: d.code, num: d.permanentNumber })) };
  return ALL;
}
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------- Perfil ----------
async function profile(id) {
  const [all, kd] = await Promise.all([getLocal(`${H}/drivers.json`), getLocal(`${H}/drivers/${id}.json`)]);
  const base = all?.find((d) => d.id === id);
  // dados recentes da Jolpica (a época actual pode não estar no Kaggle)
  const [info, stand, res] = await Promise.all([
    erg(`drivers/${id}`, {}, 86400 * 7).then((d) => d.DriverTable.Drivers[0]).catch(() => null),
    kd ? Promise.resolve(null) : ergAll(`drivers/${id}/driverStandings`, 86400, 'StandingsTable', 'StandingsLists').catch(() => []),
    kd ? Promise.resolve(null) : ergAll(`drivers/${id}/results`, 86400).catch(() => []),
  ]);
  if (!info && !base) throw new Error('Piloto não encontrado');
  const P = {
    id, name: base?.name || `${info.givenName} ${info.familyName}`, nat: base?.nat || info?.nationality, dob: base?.dob || info?.dateOfBirth,
    num: base?.num || info?.permanentNumber, code: base?.code || info?.code, url: info?.url, teams: base?.teams || [],
  };
  if (kd) {
    P.seasons = kd.seasons; P.wins = kd.wins; P.finishes = kd.finishes; P.dnf = kd.dnf;
    P.totals = { titles: base.titles, wins: base.wins, podiums: base.podiums, poles: base.poles, starts: base.starts, points: base.points, fl: base.fl };
    P.source = 'Kaggle';
  } else {
    const seasons = new Map();
    for (const s of stand) {
      const ds = s.DriverStandings[0];
      seasons.set(+s.season, { year: +s.season, team: ds.Constructors.map((c) => c.name).join(', '), teamId: ds.Constructors.at(-1)?.constructorId, pos: +ds.position || null, points: +ds.points, wins: +ds.wins, starts: 0, podiums: 0, poles: 0, best: null, dnf: 0 });
    }
    const finishes = {}; let dnf = 0; const wins = []; let poles = 0, podiums = 0, fl = 0;
    for (const r of res) {
      const x = r.Results[0];
      const y = +r.season;
      const s = seasons.get(y) || (seasons.set(y, { year: y, team: x.Constructor.name, teamId: x.Constructor.constructorId, pos: null, points: 0, wins: 0, starts: 0, podiums: 0, poles: 0, best: null, dnf: 0 }), seasons.get(y));
      s.starts++;
      const fin = /^\d+$/.test(x.positionText);
      const pos = +x.position;
      if (fin) { finishes[pos] = (finishes[pos] || 0) + 1; s.best = s.best ? Math.min(s.best, pos) : pos; }
      if (!/Finished|\+\d+ Laps?/.test(x.status)) { dnf++; s.dnf++; }
      if (pos <= 3 && fin) { podiums++; s.podiums++; }
      if (x.grid === '1') { poles++; s.poles++; }
      if (x.FastestLap?.rank === '1') fl++;
      if (pos === 1 && fin) wins.push({ year: y, round: +r.round, race: r.raceName, grid: +x.grid });
    }
    P.seasons = [...seasons.values()].sort((a, b) => a.year - b.year);
    P.finishes = finishes; P.dnf = dnf; P.wins = wins;
    P.totals = { titles: P.seasons.filter((s) => s.pos === 1 && s.year < NOW_Y).length, wins: wins.length, podiums, poles, starts: res.length, points: P.seasons.reduce((a, s) => a + (s.points || 0), 0), fl };
    P.source = 'Jolpica';
  }
  // época actual (se o Kaggle ainda não a tiver)
  if (kd && !P.seasons.some((s) => s.year === NOW_Y)) {
    try {
      const cur = await erg(`${NOW_Y}/drivers/${id}/driverStandings`, {}, 1800);
      const ds = cur.StandingsTable.StandingsLists[0]?.DriverStandings[0];
      if (ds) P.seasons.push({ year: NOW_Y, team: ds.Constructors.map((c) => c.name).join(', '), teamId: ds.Constructors.at(-1)?.constructorId, pos: +ds.position, points: +ds.points, wins: +ds.wins, live: true });
    } catch { /* */ }
  }
  P.teamId = P.seasons.at(-1)?.teamId;
  P.color = teamColor(P.teamId, P.seasons.at(-1)?.team);
  // fotografia (OpenF1, só pilotos recentes)
  if (P.seasons.at(-1)?.year >= 2023 && P.code) {
    try { const d = await getJSON(`${CONFIG.openf1}/drivers?session_key=latest&name_acronym=${P.code}`, { ttl: 86400 }); P.headshot = d[0]?.headshot_url; } catch { /* */ }
  }
  return P;
}

const age = (dob) => { if (!dob) return null; const d = new Date(dob); const n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };

function statCards(P) {
  const t = P.totals;
  return [[t.titles, 'Títulos'], [t.wins, 'Vitórias'], [t.podiums, 'Pódios'], [t.poles, 'Poles'], [t.starts, 'GP'], [fmt.pts(t.points), 'Pontos']]
    .map(([v, l]) => `<div class="card"><div class="stat"><span class="v">${v ?? '—'}</span><span class="l">${l}</span></div></div>`).join('');
}

async function renderProfile(id, vs) {
  const el = $('#view');
  el.innerHTML = `<div class="card">${skeleton(12)}</div>`;
  const [P, V] = await Promise.all([profile(id), vs ? profile(vs).catch(() => null) : null]);
  document.title = `${P.name} · ${CONFIG.siteName}`;
  const initials = P.name.split(' ').map((w) => w[0]).slice(0, 2).join('');
  const seasonsDone = P.seasons;
  el.innerHTML = `
    <div class="card" style="background:linear-gradient(115deg, ${P.color}33, transparent 55%), var(--surface)">
      <div class="profile-head">
        <div class="avatar" style="border:2px solid ${P.color}">${P.headshot ? `<img src="${esc(P.headshot)}" alt="">` : esc(initials)}</div>
        <div>
          <div class="muted" style="font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:13px">${flagNat(P.nat)} ${esc(P.nat || '')}${P.num ? ` · #${esc(P.num)}` : ''}${P.code ? ` · ${esc(P.code)}` : ''}</div>
          <h2 style="font-size:clamp(28px,4vw,44px);font-weight:900;font-style:italic;text-transform:uppercase">${esc(P.name)}</h2>
          <div class="text-2">${P.dob ? `Nascido a ${esc(fmt.date(P.dob))} (${age(P.dob)} anos)` : ''} · ${seasonsDone[0]?.year}–${seasonsDone.at(-1)?.year}${P.url ? ` · <a href="${esc(P.url)}" target="_blank" rel="noopener" style="text-decoration:underline">Wikipedia</a>` : ''}</div>
        </div>
      </div>
    </div>
    <div class="grid mt" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">${statCards(P)}</div>
    <div class="card mt">
      <div class="row-flex" style="justify-content:space-between"><div class="card-title" style="margin:0">Comparar com outro piloto</div>
      <div class="row-flex"><input class="input" id="vsInput" list="vsList" placeholder="Escreva um nome…" value="${V ? esc(V.name) : ''}" style="min-width:240px"><datalist id="vsList"></datalist>${V ? '<button class="btn small" id="vsClear">Limpar</button>' : ''}</div></div>
      ${V ? compareHtml(P, V) : ''}
    </div>
    <div class="grid g-2 mt">
      <div class="card"><div class="card-title">Posição no campeonato</div><div id="cPos"></div></div>
      <div class="card"><div class="card-title">Pontos por época <span class="right muted">sistemas de pontos variaram</span></div><div id="cPts"></div></div>
    </div>
    <div class="grid g-main mt">
      <div class="card flush"><div class="card-title" style="padding:16px 16px 0">Época a época</div><div class="table-wrap"><table class="t"><thead><tr><th>Ano</th><th>Equipa</th><th class="r">Pos</th><th class="r">Pts</th><th class="r">V</th><th class="r">Pód</th><th class="r">Poles</th><th class="r">GP</th></tr></thead><tbody>
        ${[...seasonsDone].reverse().map((s) => `<tr class="clickable" onclick="location.href='epoca.html?ano=${s.year}'"><td class="mono"><b>${s.year}</b></td><td><div class="driver-cell"><span class="team-bar" style="background:${teamColor(s.teamId, s.team)}"></span>${esc(s.team || '')}</div></td><td class="r mono ${s.pos <= 3 ? 'p' + s.pos : ''}">${s.pos ? 'P' + s.pos : '—'}${s.live ? ' <span class="chip red" style="font-size:10px">actual</span>' : ''}</td><td class="r mono">${fmt.pts(s.points)}</td><td class="r mono">${s.wins ?? '—'}</td><td class="r mono">${s.podiums ?? '—'}</td><td class="r mono">${s.poles ?? '—'}</td><td class="r mono">${s.starts ?? '—'}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div>
        <div class="card"><div class="card-title">Resultados finais <span class="right muted">${P.dnf} abandonos</span></div><div id="dist"></div></div>
        <div class="card mt-s"><div class="card-title">Vitórias (${P.wins.length})</div><div class="scroll-y" style="max-height:360px">${P.wins.length ? [...P.wins].reverse().map((w) => `<a class="row-flex" href="epoca.html?ano=${w.year}&ronda=${w.round}" style="padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:14.5px"><span class="mono muted">${w.year}</span><span style="flex:1">${esc(w.race)}</span><span class="mono muted">P${w.grid} → P1</span></a>`).join('') : '<p class="muted">Ainda sem vitórias.</p>'}</div></div>
      </div>
    </div>
    <p class="muted mt" style="font-size:12.5px">Fonte: ${P.source === 'Kaggle' ? 'dataset Kaggle (+ Jolpica para a época actual)' : 'Jolpica/Ergast'}. Poles = largar do 1.º lugar.</p>`;

  const xs = seasonsDone.map((s) => s.year);
  const series = [{ name: P.name, color: P.color, xs, ys: seasonsDone.map((s) => s.pos), width: 2.4, dots: true }];
  if (V) series.push({ name: V.name, color: V.color === P.color ? '#ffffff' : V.color, xs: V.seasons.map((s) => s.year), ys: V.seasons.map((s) => s.pos), width: 2.4, dots: true, dash: [5, 4] });
  new LineChart($('#cPos'), series, { height: 240, invertY: true, yMin: 1, xFormat: (v) => Math.round(v), yFormat: (v) => `P${Math.round(v)}`, tipTitle: (x) => Math.round(x) });
  const ptsSeries = [{ name: P.name, color: P.color, xs, ys: seasonsDone.map((s) => s.points), width: 2.4, dots: true }];
  if (V) ptsSeries.push({ name: V.name, color: series[1].color, xs: V.seasons.map((s) => s.year), ys: V.seasons.map((s) => s.points), width: 2.4, dots: true, dash: [5, 4] });
  new LineChart($('#cPts'), ptsSeries, { height: 240, yMin: 0, xFormat: (v) => Math.round(v), yFormat: (v) => fmt.pts(v), tipTitle: (x) => Math.round(x) });

  const fin = Object.entries(P.finishes).map(([k, v]) => [+k, v]).filter(([k]) => k <= 20).sort((a, b) => a[0] - b[0]);
  const maxF = Math.max(1, ...fin.map(([, v]) => v), P.dnf);
  $('#dist').innerHTML = `<div style="display:flex;align-items:flex-end;gap:3px;height:150px">${[...fin, ['DNF', P.dnf]].map(([k, v]) => `<div title="${k === 'DNF' ? 'Abandonos' : 'P' + k}: ${v}" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;height:100%;justify-content:flex-end"><span class="mono" style="font-size:10px;color:var(--muted)">${v || ''}</span><i style="width:100%;height:${(v / maxF) * 100}%;min-height:${v ? 2 : 0}px;background:${k === 'DNF' ? 'var(--surface-3)' : k === 1 ? 'var(--yellow)' : k <= 3 ? P.color : P.color + '99'};border-radius:3px 3px 0 0"></i><span class="mono" style="font-size:10px">${k === 'DNF' ? '✕' : k}</span></div>`).join('')}</div>`;

  // comparação
  const all = await allDrivers().catch(() => null);
  if (all) $('#vsList').innerHTML = all.list.slice(0, 2000).map((d) => `<option value="${esc(d.name)}">`).join('');
  $('#vsInput').addEventListener('change', (e) => {
    const hit = all?.list.find((d) => norm(d.name) === norm(e.target.value));
    if (hit) { setQs({ vs: hit.id }); renderProfile(id, hit.id); }
  });
  $('#vsClear')?.addEventListener('click', () => { setQs({ vs: null }); renderProfile(id, null); });
}

function compareHtml(A, B) {
  const rows = [['Títulos', 'titles'], ['Vitórias', 'wins'], ['Pódios', 'podiums'], ['Poles', 'poles'], ['GP', 'starts'], ['Pontos', 'points']];
  const pct = (a, b) => (a + b ? (a / (a + b)) * 100 : 50);
  const ratios = [['% vitórias', (P) => (P.totals.starts ? (P.totals.wins / P.totals.starts) * 100 : 0)], ['% pódios', (P) => (P.totals.starts ? (P.totals.podiums / P.totals.starts) * 100 : 0)], ['% poles', (P) => (P.totals.starts ? (P.totals.poles / P.totals.starts) * 100 : 0)]];
  const bc = B.color === A.color ? '#ffffff' : B.color;
  // grelha de 3 colunas: piloto A (célula à esquerda) · estatística + barra · piloto B (célula à direita)
  const COLS = 'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) minmax(0,1fr);gap:clamp(6px,1.5vw,10px);align-items:stretch';
  const cell = (side, color, html, win) => `<div style="background:var(--surface-2);border:1px solid ${win ? color : 'var(--line)'};border-radius:10px;padding:10px clamp(8px,2.5vw,14px);display:flex;align-items:center;justify-content:${side === 'l' ? 'flex-start' : 'flex-end'};text-align:${side === 'l' ? 'left' : 'right'}">${html}</div>`;
  const line = (lbl, a, b, f = (v) => fmt.pts(v)) => `<div style="${COLS};margin:8px 0">
      ${cell('l', A.color, `<b class="mono" style="font-size:clamp(15px,4vw,20px);${a > b ? `color:${A.color}` : ''}">${f(a)}</b>`, a > b)}
      <div style="display:flex;flex-direction:column;justify-content:center;gap:6px"><div class="muted" style="font-size:11.5px;text-align:center;font-weight:700;text-transform:uppercase;letter-spacing:.08em">${lbl}</div><div style="display:flex;height:8px;border-radius:5px;overflow:hidden;background:var(--surface-3)"><i style="width:${pct(a, b)}%;background:${A.color}"></i><i style="width:${100 - pct(a, b)}%;background:${bc}"></i></div></div>
      ${cell('r', bc, `<b class="mono" style="font-size:clamp(15px,4vw,20px);${b > a ? `color:${bc}` : ''}">${f(b)}</b>`, b > a)}
    </div>`;
  const head = (side, P, color, html) => `<div style="border-${side === 'l' ? 'left' : 'right'}:4px solid ${color};padding:${side === 'l' ? '4px 0 4px 12px' : '4px 12px 4px 0'};text-align:${side === 'l' ? 'left' : 'right'};font-weight:900;font-size:clamp(13px,3.3vw,18px);line-height:1.2;overflow-wrap:break-word">${html}</div>`;
  return `<div class="mt">
    <div style="${COLS};align-items:center;margin-bottom:4px">
      ${head('l', A, A.color, `${flagNat(A.nat)} ${esc(A.name)}`)}
      <div class="muted" style="text-align:center;font-weight:900;font-style:italic">VS</div>
      ${head('r', B, bc, `<a href="pilotos.html?id=${esc(B.id)}">${esc(B.name)} ${flagNat(B.nat)}</a>`)}
    </div>
    ${rows.map(([l, k]) => line(l, A.totals[k] || 0, B.totals[k] || 0)).join('')}
    ${ratios.map(([l, f]) => line(l, f(A), f(B), (v) => v.toFixed(1) + '%')).join('')}
  </div>`;
}

// ---------- Lista ----------
async function renderList() {
  const el = $('#view');
  el.innerHTML = `<div class="card">${skeleton(10)}</div>`;
  // grelha actual em destaque
  let grid = [];
  try {
    const d = await erg('current/driverStandings', {}, 1800);
    grid = d.StandingsTable.StandingsLists[0]?.DriverStandings || [];
  } catch { /* */ }
  el.innerHTML = `
    ${grid.length ? `<div class="section-head"><h2>Grelha ${NOW_Y}</h2></div><div class="grid g-4 mb">${grid.map((x) => { const c = teamColor(x.Constructors.at(-1)?.constructorId); return `<a class="card hover" href="pilotos.html?id=${esc(x.Driver.driverId)}" style="border-left:4px solid ${c};padding:14px 16px"><div class="row-flex" style="justify-content:space-between"><span class="mono muted">P${x.position}</span><span class="mono" style="font-size:26px;font-weight:900;color:${c};opacity:.8">${esc(x.Driver.permanentNumber || '')}</span></div><div style="font-weight:600">${flagNat(x.Driver.nationality)} ${esc(x.Driver.givenName)}</div><div style="font-weight:900;font-size:20px;text-transform:uppercase;line-height:1">${esc(x.Driver.familyName)}</div><div class="muted" style="font-size:13px;margin-top:4px">${esc(x.Constructors.at(-1)?.name || '')} · ${fmt.pts(+x.points)} pts</div></a>`; }).join('')}</div>` : ''}
    <div class="section-head"><h2>Todos os pilotos</h2></div>
    <div class="row-flex mb"><input class="input" id="search" placeholder="Pesquisar por nome ou nacionalidade…" style="flex:1;min-width:220px"><select class="select" id="sort"></select></div>
    <div class="card flush"><div class="table-wrap" id="tbl">${skeleton(8)}</div></div>
    <div class="row-flex mt-s" style="justify-content:center"><button class="btn" id="more">Mostrar mais</button></div>`;
  const all = await allDrivers();
  const K = all.kaggle;
  $('#sort').innerHTML = K ? [['titles', 'Títulos'], ['wins', 'Vitórias'], ['podiums', 'Pódios'], ['poles', 'Poles'], ['starts', 'GP'], ['points', 'Pontos'], ['last', 'Mais recentes'], ['name', 'Nome']].map(([v, l]) => `<option value="${v}">Ordenar: ${l}</option>`).join('') : '<option value="name">Ordenar: Nome</option><option value="dob">Ordenar: Mais novos</option>';
  let shown = 60;
  const draw = () => {
    const qv = norm($('#search').value);
    const key = $('#sort').value;
    let L = all.list.filter((d) => !qv || norm(d.name).includes(qv) || norm(d.nat).includes(qv) || norm(d.code).includes(qv));
    L = [...L].sort((a, b) => (key === 'name' ? a.name.localeCompare(b.name) : key === 'dob' ? (b.dob || '').localeCompare(a.dob || '') : (b[key] || 0) - (a[key] || 0) || (b.wins || 0) - (a.wins || 0)));
    $('#more').classList.toggle('hidden', L.length <= shown);
    $('#tbl').innerHTML = `<table class="t"><thead><tr><th>Piloto</th>${K ? '<th class="r">Títulos</th><th class="r">Vitórias</th><th class="r">Pódios</th><th class="r">Poles</th><th class="r">GP</th><th class="r">Pontos</th><th class="r">Anos</th>' : '<th>Nascimento</th><th>Nº</th>'}</tr></thead><tbody>${L.slice(0, shown).map((d) => `<tr class="clickable" data-id="${esc(d.id)}"><td>${flagNat(d.nat)} <b>${esc(d.name)}</b> ${d.code ? `<span class="muted mono" style="font-size:12px">${esc(d.code)}</span>` : ''}</td>${K ? `<td class="r mono ${d.titles ? 'p1' : ''}">${d.titles || ''}</td><td class="r mono">${d.wins}</td><td class="r mono">${d.podiums}</td><td class="r mono">${d.poles}</td><td class="r mono">${d.starts}</td><td class="r mono">${fmt.pts(d.points)}</td><td class="r mono muted">${d.first}–${d.last}</td>` : `<td class="muted">${esc(fmt.date(d.dob))}</td><td class="mono">${esc(d.num || '')}</td>`}</tr>`).join('')}</tbody></table>${!K ? '<p class="muted" style="padding:12px 14px;font-size:13px">Instale os dados do Kaggle para ver estatísticas de carreira nesta tabela (ver README).</p>' : ''}`;
  };
  $('#search').addEventListener('input', () => { shown = 60; draw(); });
  $('#sort').addEventListener('change', draw);
  $('#more').addEventListener('click', () => { shown += 120; draw(); });
  $('#tbl').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.href = `pilotos.html?id=${tr.dataset.id}`; });
  draw();
}

init(async () => {
  $('#app').innerHTML = `<section class="page-hero container" id="hero"><h1>Pi<em>lotos</em></h1><p>Mais de 850 pilotos em 75 anos. Pesquise qualquer um, veja a carreira época a época e compare lendas de eras diferentes.</p></section><section class="section container" style="padding-top:16px"><div id="view"></div></section>`;
  const id = qs('id');
  if (id) {
    $('#hero').innerHTML = `<a class="link muted" href="pilotos.html">← Todos os pilotos</a>`;
    try { await renderProfile(id, qs('vs')); } catch (e) { $('#view').innerHTML = `<div class="card">${errorBox('Piloto não encontrado.', e.message)}</div>`; }
  } else {
    try { await renderList(); } catch (e) { $('#view').innerHTML = `<div class="card">${errorBox('Não foi possível carregar a lista de pilotos.', e.message)}</div>`; }
  }
});
