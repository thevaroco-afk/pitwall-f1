import { init, $, esc, erg, ergAll, fmt, raceDate, flagCountry, flagNat, teamColor, skeleton, errorBox, currentLiveSession, weekendSessions } from './core.js';
import { loadNews, newsCard } from './news.js';

async function getSchedule() {
  const y = new Date().getFullYear();
  let races = (await erg('current', {}, 3600)).RaceTable.Races;
  const now = Date.now();
  let next = races.find((r) => raceDate(r).getTime() + 3 * 3600e3 > now);
  if (!next) {
    try { const nxt = (await erg(`${y + 1}`, {}, 3600)).RaceTable.Races; if (nxt.length) { races = nxt; next = nxt[0]; } } catch { /* */ }
  }
  return { races, next };
}

function countdown(el, target) {
  const tick = () => {
    let s = Math.max(0, Math.floor((target - Date.now()) / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    el.innerHTML = [[d, 'dias'], [h, 'horas'], [m, 'min'], [s, 'seg']].map(([v, l]) => `<div class="u"><b>${String(v).padStart(2, '0')}</b><span>${l}</span></div>`).join('');
  };
  tick();
  setInterval(tick, 1000);
}

function heroHtml(next) {
  const sess = weekendSessions(next);
  const now = Date.now();
  const upcoming = sess.find((s) => s.date.getTime() + 2 * 3600e3 > now) || sess[sess.length - 1];
  const loc = next.Circuit.Location;
  return `<div class="hero-card fade-in">
    <div>
      <div class="eyebrow"><span>Ronda ${next.round} · ${next.season}</span><span id="liveChip"></span></div>
      <h1>${flagCountry(loc.country)} ${esc(next.raceName.replace('Grand Prix', 'GP'))}</h1>
      <div class="sub">${esc(next.Circuit.circuitName)} · ${esc(loc.locality)}, ${esc(loc.country)}</div>
      <div class="sub mt-s" style="font-size:15px">Próxima sessão: <b style="color:#fff">${esc(upcoming.name)}</b> · ${esc(fmt.weekday(upcoming.date))} às ${esc(fmt.time(upcoming.date))}</div>
      <div class="countdown" id="cd"></div>
      <div class="row-flex mt">
        <a class="btn primary" href="aovivo.html">● Ao Vivo / Replay</a>
        <a class="btn" href="epoca.html">Calendário completo</a>
        <a class="btn" href="circuitos.html?c=${esc(next.Circuit.circuitId)}">Sobre o circuito</a>
      </div>
    </div>
    <div>
      <div class="card-title">Horários do fim-de-semana <span class="right muted">hora local</span></div>
      <div class="sessions-list">${sess.map((s) => {
        const done = s.date.getTime() + 2 * 3600e3 < now;
        return `<div class="s ${done ? 'done' : ''} ${s === upcoming ? 'next' : ''}"><span class="nm">${esc(s.name)}</span><span class="d">${esc(fmt.weekday(s.date))}</span><span class="h">${esc(fmt.time(s.date))}</span></div>`;
      }).join('')}</div>
    </div>
  </div>`;
}

function barRows(list, max) {
  return list.map((x, i) => `<div class="bar-row"><span class="pos mono ${i < 3 ? 'p' + (i + 1) : ''}">${i + 1}</span><span class="nm">${x.flag || ''} ${esc(x.name)}</span><span class="bar"><i style="width:${(x.v / (max || 1)) * 100}%;background:${x.color}"></i></span><span class="n">${fmt.pts(x.v)}</span></div>`).join('');
}

init(async () => {
  const app = $('#app');
  app.innerHTML = `
    <section class="hero container"><div id="hero">${`<div class="hero-card"><div>${skeleton(6)}</div><div>${skeleton(6)}</div></div>`}</div></section>
    <section class="section container">
      <div class="grid g-3">
        <div class="card"><div class="card-title">Último Grande Prémio <a class="right link" href="epoca.html" id="lastLink">resultados →</a></div><div id="last">${skeleton(5)}</div></div>
        <div class="card"><div class="card-title">Pilotos <a class="right link" href="epoca.html?tab=pilotos">tabela →</a></div><div id="drv">${skeleton(8)}</div></div>
        <div class="card"><div class="card-title">Construtores <a class="right link" href="epoca.html?tab=construtores">tabela →</a></div><div id="con">${skeleton(8)}</div></div>
      </div>
    </section>
    <section class="section container" style="padding-top:0">
      <div class="section-head"><h2>A época em números</h2><a class="link" href="epoca.html?tab=stats">mais estatísticas →</a></div>
      <div class="grid g-4" id="nums">${Array(4).fill(`<div class="card">${skeleton(2)}</div>`).join('')}</div>
    </section>
    <section class="section container" style="padding-top:0">
      <div class="section-head"><h2>Últimas notícias</h2><a class="link" href="noticias.html">todas as notícias →</a></div>
      <div class="news-grid" id="news">${Array(6).fill(`<div class="card">${skeleton(4)}</div>`).join('')}</div>
    </section>
    <section class="section container" style="padding-top:0">
      <div class="grid g-3">
        <a class="card hover" href="telemetria.html"><div class="card-title">Telemetria</div><h3 style="font-size:22px">Quem trava mais tarde?</h3><p class="text-2 mt-s">Compare velocidade, acelerador, travão e mudanças volta a volta, com delta e domínio por mini-sector.</p></a>
        <a class="card hover" href="historia.html"><div class="card-title">História</div><h3 style="font-size:22px">75 anos de campeões</h3><p class="text-2 mt-s">Todos os campeões, recordes de sempre e comparação de pilotos de épocas diferentes.</p></a>
        <a class="card hover" href="circuitos.html"><div class="card-title">Circuitos</div><h3 style="font-size:22px">Uma volta ao mundo</h3><p class="text-2 mt-s">O mapa de todos os circuitos que já receberam a F1, com os vencedores de cada um.</p></a>
      </div>
    </section>`;

  // Próxima corrida
  getSchedule().then(({ next }) => {
    if (!next) { $('#hero').innerHTML = errorBox('Calendário indisponível.'); return; }
    $('#hero').innerHTML = heroHtml(next);
    const sess = weekendSessions(next);
    const target = (sess.find((s) => s.date > Date.now()) || sess[sess.length - 1]).date;
    countdown($('#cd'), target);
    currentLiveSession().then((s) => {
      if (s) $('#liveChip').innerHTML = `<a class="chip live" href="aovivo.html">AO VIVO · ${esc(s.session_name)}</a>`;
    }).catch(() => {});
  }).catch((e) => { $('#hero').innerHTML = `<div class="card">${errorBox('Não foi possível ler o calendário.', e.message)}</div>`; });

  // Último GP
  erg('current/last/results', {}, 900).then((d) => {
    const r = d.RaceTable.Races[0];
    if (!r) { $('#last').innerHTML = errorBox('Ainda não há corridas esta época.'); return; }
    $('#lastLink').href = `epoca.html?ano=${r.season}&ronda=${r.round}`;
    const top = r.Results.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter(Boolean);
    const fl = r.Results.find((x) => x.FastestLap?.rank === '1');
    $('#last').innerHTML = `<div class="fade-in">
      <div style="font-weight:800;font-size:19px">${flagCountry(r.Circuit.Location.country)} ${esc(r.raceName)}</div>
      <div class="muted" style="font-size:14px">${esc(fmt.date(raceDate(r)))} · ${esc(r.Circuit.circuitName)}</div>
      <div class="podium mt">${order.map((x) => `<div class="pd"><div class="who">${flagNat(x.Driver.nationality)} ${esc(x.Driver.code || x.Driver.familyName)}</div><div class="tm">${esc(x.Constructor.name)}</div><div class="bar" style="background:${teamColor(x.Constructor.constructorId)}"></div><div class="blk">${x.position}</div></div>`).join('')}</div>
      ${fl ? `<div class="row-flex mt-s" style="font-size:14px"><span class="chip" style="background:rgba(177,76,255,.18);color:#d39bff">Volta mais rápida</span><b>${esc(fl.Driver.familyName)}</b><span class="mono">${esc(fl.FastestLap.Time?.time || '')}</span></div>` : ''}
    </div>`;
  }).catch((e) => { $('#last').innerHTML = errorBox('Sem resultados.', e.message); });

  // Classificações
  erg('current/driverStandings', {}, 900).then((d) => {
    const L = d.StandingsTable.StandingsLists[0]?.DriverStandings || [];
    const list = L.slice(0, 10).map((x) => ({ name: `${x.Driver.givenName[0]}. ${x.Driver.familyName}`, flag: flagNat(x.Driver.nationality), v: +x.points, color: teamColor(x.Constructors.at(-1)?.constructorId) }));
    $('#drv').innerHTML = list.length ? barRows(list, list[0]?.v) : errorBox('Sem classificação.');
  }).catch((e) => { $('#drv').innerHTML = errorBox('Sem classificação.', e.message); });
  erg('current/constructorStandings', {}, 900).then((d) => {
    const L = d.StandingsTable.StandingsLists[0]?.ConstructorStandings || [];
    const list = L.map((x) => ({ name: x.Constructor.name, v: +x.points, color: teamColor(x.Constructor.constructorId, x.Constructor.name) }));
    $('#con').innerHTML = list.length ? barRows(list, list[0]?.v) : errorBox('Sem classificação.');
  }).catch((e) => { $('#con').innerHTML = errorBox('Sem classificação.', e.message); });

  // Números
  Promise.all([ergAll('current/results/1', 900), erg('current', {}, 3600), ergAll('current/qualifying/1', 900).catch(() => [])]).then(([wins, sched, poles]) => {
    const total = sched.RaceTable.Races.length;
    const done = wins.length;
    const byW = {};
    for (const r of wins) { const x = r.Results[0]; const k = x.Driver.familyName; byW[k] = (byW[k] || 0) + 1; }
    const winners = Object.entries(byW).sort((a, b) => b[1] - a[1]);
    const poleWins = wins.filter((r) => r.Results[0].grid === '1').length;
    const byP = {};
    for (const r of poles) { const k = r.QualifyingResults?.[0]?.Driver.familyName; if (k) byP[k] = (byP[k] || 0) + 1; }
    const topPole = Object.entries(byP).sort((a, b) => b[1] - a[1])[0];
    const cards = [
      [`${done}<span class="muted" style="font-size:20px">/${total}</span>`, 'Corridas disputadas'],
      [winners.length, 'Vencedores diferentes'],
      [winners[0] ? winners[0][1] : '—', `Mais vitórias${winners[0] ? ' · ' + esc(winners[0][0]) : ''}`],
      [topPole ? topPole[1] : (done ? `${Math.round((poleWins / done) * 100)}%` : '—'), topPole ? `Mais poles · ${esc(topPole[0])}` : 'Vitórias desde a pole'],
    ];
    $('#nums').innerHTML = cards.map(([v, l]) => `<div class="card fade-in"><div class="stat"><span class="v">${v}</span><span class="l">${l}</span></div></div>`).join('');
  }).catch((e) => { $('#nums').innerHTML = `<div class="card">${errorBox('Sem estatísticas.', e.message)}</div>`; });

  // Notícias
  loadNews().then((items) => {
    $('#news').innerHTML = items.length ? items.slice(0, 6).map(newsCard).join('') : errorBox('Sem notícias de momento.');
  }).catch(() => { $('#news').innerHTML = errorBox('Não foi possível carregar as notícias.'); });
});
