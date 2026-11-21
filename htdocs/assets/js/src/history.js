// =========================================================
// HISTÓRIA — campeões, recordes, eras (Kaggle) com alternativa Jolpica
// =========================================================
import { init, $, $$, esc, getLocal, ergAll, fmt, flagNat, teamColor, skeleton, errorBox, tabs, qs, setQs } from './core.js';
import { CONFIG } from './config.js';
import { LineChart } from './charts.js';

const H = CONFIG.historyData;
let IDX = null, REC = null;

async function champions() {
  if (IDX) return IDX.seasons.filter((s) => s.champion).map((s) => ({ ...s, inProgress: s.inProgress }));
  const [d, c] = await Promise.all([
    ergAll('driverStandings/1', 86400, 'StandingsTable', 'StandingsLists'),
    ergAll('constructorStandings/1', 86400, 'StandingsTable', 'StandingsLists').catch(() => []),
  ]);
  const cmap = new Map(c.map((x) => [x.season, x.ConstructorStandings[0]]));
  const nowY = new Date().getFullYear();
  return d.map((x) => {
    const s = x.DriverStandings[0];
    const cs = cmap.get(x.season);
    return {
      year: +x.season, races: null, inProgress: +x.season === nowY,
      champion: { id: s.Driver.driverId, name: `${s.Driver.givenName} ${s.Driver.familyName}`, nat: s.Driver.nationality, points: +s.points, wins: +s.wins, team: s.Constructors.at(-1)?.name, teamId: s.Constructors.at(-1)?.constructorId },
      constructor: cs ? { id: cs.Constructor.constructorId, name: cs.Constructor.name, points: +cs.points, wins: +cs.wins } : null,
    };
  });
}

function champCard(s) {
  const c = s.champion;
  return `<a class="c" href="epoca.html?ano=${s.year}" style="border-top:3px solid ${teamColor(c.teamId, c.team)}"><div class="y">${s.year}${s.inProgress ? ' <span class="chip red" style="font-size:10px">a decorrer</span>' : ''}</div><div class="n">${flagNat(c.nat)} ${esc(c.name)}</div><div class="t">${esc(c.team || '')}</div>${Object.hasOwn(s, "constructor") && s.constructor ? `<div class="t" style="margin-top:4px">🏭 ${esc(s.constructor.name)}</div>` : ''}</a>`;
}

async function renderChampions(el) {
  const list = (await champions()).sort((a, b) => b.year - a.year);
  const decades = [...new Set(list.map((s) => Math.floor(s.year / 10) * 10))];
  const done = list.filter((s) => !s.inProgress);
  const count = (key, idKey) => { const m = new Map(); for (const s of done) { const o = Object.hasOwn(s, key) ? s[key] : null; if (!o) continue; const k = o[idKey]; const e = m.get(k) || { name: o.name || o.team, nat: o.nat, id: o.id, teamId: o.teamId || o.id, v: 0, years: [] }; e.v++; e.years.push(s.year); m.set(k, e); } return [...m.values()].sort((a, b) => b.v - a.v || a.years[0] - b.years[0]); };
  const dT = count('champion', 'id'), cT = count('constructor', 'id');
  const nats = new Map(); for (const s of done) nats.set(s.champion.nat, (nats.get(s.champion.nat) || 0) + 1);
  const natList = [...nats.entries()].sort((a, b) => b[1] - a[1]);
  el.innerHTML = `
    <div class="row-flex mb"><div class="decades" id="dec"><button class="btn small primary" data-d="">Todas</button>${decades.map((d) => `<button class="btn small" data-d="${d}">${d}s</button>`).join('')}</div></div>
    <div class="champ-strip" id="strip">${list.map(champCard).join('')}</div>
    <div class="grid g-3 mt">
      <div class="card"><div class="card-title">Mais títulos de pilotos</div><ol class="record-list">${dT.slice(0, 12).map((x, i) => `<li><span class="mono muted">${i + 1}</span><a href="pilotos.html?id=${esc(x.id)}">${flagNat(x.nat)} ${esc(x.name)} <small class="muted">${x.years.join(', ')}</small></a><span class="n">${x.v}</span></li>`).join('')}</ol></div>
      <div class="card"><div class="card-title">Mais títulos de construtores <span class="right muted">desde 1958</span></div><ol class="record-list">${cT.slice(0, 12).map((x, i) => `<li><span class="mono muted">${i + 1}</span><span><span class="team-bar" style="display:inline-block;height:12px;vertical-align:middle;background:${teamColor(x.id, x.name)}"></span> ${esc(x.name)}</span><span class="n">${x.v}</span></li>`).join('')}</ol></div>
      <div class="card"><div class="card-title">Títulos por nacionalidade</div>${natList.slice(0, 12).map(([n, v]) => `<div class="bar-row" style="grid-template-columns:28px minmax(0,130px) 1fr 34px"><span>${flagNat(n)}</span><span class="nm">${esc(n)}</span><span class="bar"><i style="width:${(v / natList[0][1]) * 100}%;background:var(--red)"></i></span><span class="n">${v}</span></div>`).join('')}</div>
    </div>`;
  $('#dec').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#dec button').forEach((x) => x.classList.toggle('primary', x === b));
    const d = b.dataset.d;
    $('#strip').innerHTML = list.filter((s) => !d || Math.floor(s.year / 10) * 10 === +d).map(champCard).join('');
  });
}

function needKaggle() {
  return `<div class="card"><div class="empty"><h3>Dados históricos completos ainda não instalados</h3><p>Esta secção usa o dataset do Kaggle convertido para JSON.</p>
    <div class="notice mt" style="text-align:left;max-width:680px;margin-left:auto;margin-right:auto">1. Descarregue o dataset <b>Formula 1 World Championship</b> do Kaggle e descompacte.<br>2. No seu computador: <code>python tools/kaggle_to_json.py pasta_dos_csv</code><br>3. Envie a pasta <code>htdocs/data/history</code> para o site por FTP.</div></div></div>`;
}

function recList(title, list, f = (x) => fmt.num(x.v), link = true, sub = null) {
  return `<div class="card"><div class="card-title">${title}</div><ol class="record-list">${(list || []).map((x, i) => `<li><span class="mono muted ${i < 3 ? 'p' + (i + 1) : ''}">${i + 1}</span><span>${link && x.id ? `<a href="pilotos.html?id=${esc(x.id)}">` : ''}${x.nat ? flagNat(x.nat) + ' ' : ''}${esc(x.name)}${link && x.id ? '</a>' : ''}${sub ? ` <small class="muted">${esc(sub(x))}</small>` : ''}</span><span class="n">${f(x)}</span></li>`).join('')}</ol></div>`;
}

async function renderRecords(el) {
  if (!REC) { el.innerHTML = needKaggle(); return; }
  const r = REC, d = r.drivers, c = r.constructors, t = r.totals;
  el.innerHTML = `
    <div class="grid g-4 mb">${[[t.races, 'Grandes Prémios'], [t.drivers, 'Pilotos'], [t.winners, 'Vencedores diferentes'], [t.constructors, 'Construtores']].map(([v, l]) => `<div class="card"><div class="stat"><span class="v">${fmt.num(v)}</span><span class="l">${l}</span></div></div>`).join('')}</div>
    <h3 class="mb" style="font-size:20px">Pilotos</h3>
    <div class="grid g-3">${recList('Vitórias', d.wins)}${recList('Pole positions', d.poles)}${recList('Pódios', d.podiums)}${recList('Grandes Prémios disputados', d.starts)}${recList('Pontos (todos os sistemas)', d.points, (x) => fmt.pts(x.v))}${recList('Voltas mais rápidas (desde 2004)', d.fl)}${recList('% de vitórias (mín. 30 GP)', d.winPct, (x) => x.v + '%')}${recList('% de pódios (mín. 30 GP)', d.podPct, (x) => x.v + '%')}${recList('Mais vitórias numa época', r.seasonWins, (x) => `${x.v}/${x.of}`, true, (x) => x.year)}</div>
    <h3 class="mb mt" style="font-size:20px">Curiosidades</h3>
    <div class="grid g-3">${recList('Vencedores mais novos', r.youngestWinners, (x) => `${Math.floor(x.v)}a ${Math.round((x.v % 1) * 365)}d`, true, (x) => x.race)}${recList('Vencedores mais velhos', r.oldestWinners, (x) => `${Math.floor(x.v)}a`, true, (x) => x.race)}${recList('Vitórias de mais atrás na grelha', r.winsFromBack, (x) => `P${x.v}`, true, (x) => x.race)}${recList('Títulos mais renhidos', r.closestTitles, (x) => `${fmt.pts(x.v)} pts`, false, (x) => `${x.year} · vs ${x.runnerUp}`)}</div>
    <h3 class="mb mt" style="font-size:20px">Construtores</h3>
    <div class="grid g-3">${recList('Títulos', c.titles, undefined, false)}${recList('Vitórias', c.wins, undefined, false)}${recList('Pole positions', c.poles, undefined, false)}${recList('Pódios', c.podiums, undefined, false)}${recList('Grandes Prémios', c.races, undefined, false)}</div>
    <p class="muted mt" style="font-size:13px">${esc(r.notes || '')}</p>`;
}

async function renderEras(el) {
  if (!IDX) { el.innerHTML = needKaggle(); return; }
  const S = IDX.seasons;
  const xs = S.map((s) => s.year);
  el.innerHTML = `<div class="grid g-2">
    <div class="card"><div class="card-title">Fiabilidade: % de carros que terminam</div><div id="e1"></div></div>
    <div class="card"><div class="card-title">Corridas por época</div><div id="e2"></div></div>
    <div class="card"><div class="card-title">Vencedores diferentes por época</div><div id="e3"></div></div>
    <div class="card"><div class="card-title">Margem do campeão (pontos)</div><div id="e4"></div></div>
  </div><p class="muted mt" style="font-size:13px">Arraste num gráfico para ampliar uma era. As margens dependem do sistema de pontuação de cada época.</p>`;
  const opt = { height: 230, xFormat: (v) => Math.round(v), legend: false };
  new LineChart($('#e1'), [{ name: '% terminam', color: '#22d36b', xs, ys: S.map((s) => s.finishRate), width: 2 }], { ...opt, yFormat: (v) => Math.round(v) + '%', tipTitle: (x) => Math.round(x) });
  new LineChart($('#e2'), [{ name: 'Corridas', color: '#ff1e2d', xs, ys: S.map((s) => s.races), width: 2, dots: true }], { ...opt, yMin: 0, yFormat: (v) => Math.round(v), tipTitle: (x) => Math.round(x) });
  new LineChart($('#e3'), [{ name: 'Vencedores', color: '#2f8cff', xs, ys: S.map((s) => s.winners), width: 2, dots: true }], { ...opt, yMin: 0, yFormat: (v) => Math.round(v), tipTitle: (x) => Math.round(x) });
  new LineChart($('#e4'), [{ name: 'Margem', color: '#ffd60a', xs, ys: S.map((s) => (s.inProgress ? null : s.champion?.margin)), width: 2, dots: true }], { ...opt, yMin: 0, yFormat: (v) => fmt.pts(v), tipTitle: (x) => { const s = S.find((z) => z.year === Math.round(x)); return s?.champion ? `${s.year} · ${s.champion.name} vs ${s.champion.runnerUp}` : Math.round(x); } });
}

init(async () => {
  $('#app').innerHTML = `
    <section class="page-hero container">
      <h1>His<em>tória</em></h1>
      <p>Desde Silverstone 1950 até hoje: todos os campeões, os recordes que parecem impossíveis de bater e como o desporto mudou de era para era.</p>
      <div class="tabs mt" id="tabs" style="display:inline-flex"><button class="tab" data-tab="campeoes">Campeões</button><button class="tab" data-tab="recordes">Recordes</button><button class="tab" data-tab="eras">Eras</button></div>
    </section>
    <section class="section container" style="padding-top:16px"><div id="view">${skeleton(10)}</div></section>`;
  [IDX, REC] = await Promise.all([getLocal(`${H}/index.json`), getLocal(`${H}/records.json`)]);
  const R = { campeoes: renderChampions, recordes: renderRecords, eras: renderEras };
  const show = async (t) => {
    if (!R[t]) t = 'campeoes';
    $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    setQs({ tab: t === 'campeoes' ? null : t });
    $('#view').innerHTML = `<div class="card">${skeleton(10)}</div>`;
    try { await R[t]($('#view')); } catch (e) { console.error(e); $('#view').innerHTML = `<div class="card">${errorBox('Não foi possível carregar.', e.message)}</div>`; }
  };
  tabs($('#tabs'), show);
  show(qs('tab', 'campeoes'));
});
