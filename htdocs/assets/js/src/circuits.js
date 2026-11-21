// =========================================================
// CIRCUITOS — mapa-mundo (Leaflet) + história de cada circuito
// =========================================================
import { init, $, $$, esc, getLocal, erg, ergAll, fmt, flagCountry, flagNat, teamColor, skeleton, errorBox, qs, setQs } from './core.js';
import { CONFIG } from './config.js';

let map, markers = new Map(), list = [];

async function loadCircuits() {
  const [k, all, cur] = await Promise.all([
    getLocal(`${CONFIG.historyData}/circuits.json`),
    ergAll('circuits', 86400 * 7, 'CircuitTable', 'Circuits'),
    erg('current', {}, 3600).then((d) => d.RaceTable.Races).catch(() => []),
  ]);
  const kmap = new Map((k || []).map((c) => [c.id, c]));
  const curIds = new Map(cur.map((r) => [r.Circuit.circuitId, r]));
  return all.map((c) => {
    const kc = kmap.get(c.circuitId);
    return {
      id: c.circuitId, name: c.circuitName, loc: c.Location.locality, country: c.Location.country,
      lat: +c.Location.lat, lng: +c.Location.long, url: c.url,
      races: kc?.races, first: kc?.first, last: kc?.last, topWinners: kc?.topWinners,
      current: curIds.get(c.circuitId) || null,
    };
  }).sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || a.name.localeCompare(b.name));
}

// Mapa simples (sem Leaflet): projecção equirectangular com grelha
function simpleMap(cs) {
  const el = $('#map');
  const W = 1000, H = 500;
  const px = (lng) => ((lng + 180) / 360) * W, py = (lat) => ((90 - lat) / 180) * H;
  let grid = '';
  for (let lng = -180; lng <= 180; lng += 30) grid += `<line x1="${px(lng)}" y1="0" x2="${px(lng)}" y2="${H}"/>`;
  for (let lat = -60; lat <= 60; lat += 30) grid += `<line x1="0" y1="${py(lat)}" x2="${W}" y2="${py(lat)}"/>`;
  el.style.height = 'auto';
  el.innerHTML = `<svg viewBox="0 40 ${W} ${H - 120}" style="width:100%;display:block">
    <g stroke="rgba(255,255,255,.06)" stroke-width="1">${grid}</g>
    <line x1="0" y1="${py(0)}" x2="${W}" y2="${py(0)}" stroke="rgba(255,255,255,.15)"/>
    ${cs.map((c) => `<circle data-id="${esc(c.id)}" cx="${px(c.lng).toFixed(1)}" cy="${py(c.lat).toFixed(1)}" r="${c.current ? 6 : 4}" fill="${c.current ? '#ff1e2d' : '#666'}" stroke="#fff" stroke-width="${c.current ? 1.5 : .8}" style="cursor:pointer"><title>${esc(c.name)} — ${esc(c.country)}</title></circle>`).join('')}
  </svg><p class="muted" style="font-size:12.5px;padding:8px 12px">Mapa simplificado (o mapa interactivo não carregou: verifique a internet ou bloqueadores de anúncios).</p>`;
  el.onclick = (e) => { const d = e.target.closest('circle[data-id]'); if (d) showCircuit(cs.find((c) => c.id === d.dataset.id)); };
}

async function showCircuit(c) {
  setQs({ c: c.id });
  $$('.circuit-list .it').forEach((x) => x.classList.toggle('active', x.dataset.id === c.id));
  const m = markers.get(c.id);
  if (m) { map.flyTo([c.lat, c.lng], 6, { duration: .8 }); m.openPopup(); }
  const el = $('#detail');
  el.innerHTML = `<div class="card">${skeleton(8)}</div>`;
  let winners = [];
  try { winners = await ergAll(`circuits/${c.id}/results/1`, 86400); } catch { /* */ }
  const byD = new Map(), byT = new Map();
  for (const r of winners) { const x = r.Results[0]; const k = `${x.Driver.givenName} ${x.Driver.familyName}`; byD.set(k, { n: (byD.get(k)?.n || 0) + 1, id: x.Driver.driverId, nat: x.Driver.nationality }); byT.set(x.Constructor.name, { n: (byT.get(x.Constructor.name)?.n || 0) + 1, id: x.Constructor.constructorId }); }
  const topD = [...byD.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6);
  const topT = [...byT.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6);
  const poleWins = winners.filter((r) => r.Results[0].grid === '1').length;
  const avgGrid = winners.length ? winners.reduce((a, r) => a + (+r.Results[0].grid || 0), 0) / winners.length : 0;
  const nr = c.current;
  el.innerHTML = `<div class="card fade-in">
    <div class="row-flex" style="justify-content:space-between;align-items:start">
      <div><div class="muted" style="font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:13px">${flagCountry(c.country)} ${esc(c.loc)}, ${esc(c.country)}</div><h2 style="font-size:28px;font-weight:900">${esc(c.name)}</h2></div>
      ${nr ? `<a class="chip red" href="epoca.html?ronda=${nr.round}">No calendário · Ronda ${nr.round} · ${esc(fmt.date(nr.date))}</a>` : '<span class="chip">Fora do calendário actual</span>'}
    </div>
    <div class="grid g-4 mt">${[[winners.length || c.races || '—', 'Grandes Prémios'], [winners[0]?.season || c.first || '—', 'Primeiro GP'], [winners.at(-1)?.season || c.last || '—', 'Último GP'], [winners.length ? Math.round((poleWins / winners.length) * 100) + '%' : '—', 'Vitórias da pole']].map(([v, l]) => `<div class="stat"><span class="v" style="font-size:28px">${v}</span><span class="l">${l}</span></div>`).join('')}</div>
    <div class="grid g-2 mt">
      <div><div class="card-title">Mais vitórias · pilotos</div><ol class="record-list">${topD.map(([n, v], i) => `<li><span class="mono muted">${i + 1}</span><a href="pilotos.html?id=${esc(v.id)}">${flagNat(v.nat)} ${esc(n)}</a><span class="n">${v.n}</span></li>`).join('') || '<li class="muted">—</li>'}</ol></div>
      <div><div class="card-title">Mais vitórias · equipas</div><ol class="record-list">${topT.map(([n, v], i) => `<li><span class="mono muted">${i + 1}</span><span><span class="team-bar" style="display:inline-block;height:12px;vertical-align:middle;background:${teamColor(v.id, n)}"></span> ${esc(n)}</span><span class="n">${v.n}</span></li>`).join('') || '<li class="muted">—</li>'}</ol></div>
    </div>
    ${winners.length ? `<div class="card-title mt">Todos os vencedores <span class="right muted">grelha média do vencedor: P${avgGrid.toFixed(1)}</span></div>
      <div class="table-wrap scroll-y" style="max-height:340px"><table class="t"><thead><tr><th>Ano</th><th>Vencedor</th><th>Equipa</th><th class="r">Grelha</th></tr></thead><tbody>${[...winners].reverse().map((r) => { const x = r.Results[0]; return `<tr class="clickable" onclick="location.href='epoca.html?ano=${r.season}&ronda=${r.round}'"><td class="mono"><b>${r.season}</b></td><td>${flagNat(x.Driver.nationality)} ${esc(x.Driver.givenName)} <b>${esc(x.Driver.familyName)}</b></td><td><span class="team-bar" style="display:inline-block;height:12px;vertical-align:middle;background:${teamColor(x.Constructor.constructorId, x.Constructor.name)}"></span> ${esc(x.Constructor.name)}</td><td class="r mono">P${x.grid}</td></tr>`; }).join('')}</tbody></table></div>` : ''}
    ${c.url ? `<p class="mt-s"><a class="link muted" href="${esc(c.url)}" target="_blank" rel="noopener" style="text-decoration:underline">Mais na Wikipedia →</a></p>` : ''}
  </div>`;
}

init(async () => {
  $('#app').innerHTML = `
    <section class="page-hero container"><h1>Cir<em>cuitos</em></h1><p>Todos os circuitos que já receberam um Grande Prémio de F1. Os pontos vermelhos estão no calendário desta época.</p></section>
    <section class="section container" style="padding-top:16px">
      <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(260px,1fr)" id="mapGrid">
        <div id="map"></div>
        <div class="card flush"><div style="padding:12px"><input class="input" id="cSearch" placeholder="Pesquisar circuito ou país…" style="width:100%"></div><div class="circuit-list" id="cList" style="padding:0 8px 8px">${skeleton(10)}</div></div>
      </div>
      <div id="detail" class="mt"></div>
    </section>`;
  const mq = matchMedia('(max-width: 900px)');
  const lay = () => { $('#mapGrid').style.gridTemplateColumns = mq.matches ? '1fr' : 'minmax(0,2fr) minmax(260px,1fr)'; $('#map').style.height = mq.matches ? '380px' : '560px'; };
  lay(); mq.addEventListener('change', lay);

  if (window.L) {
    map = L.map('map', { worldCopyJump: true, zoomControl: true }).setView([30, 10], 2);
    // mapa-mundo próprio (Natural Earth, ficheiro local): não depende de serviços de mosaicos nem de chaves de API
    map.getContainer().style.background = '#0b0d14';
    map.attributionControl.addAttribution('Natural Earth');
    getLocal('data/world.json').then((w) => {
      if (!w) return;
      const renderer = L.canvas({ padding: 0.5 });
      L.geoJSON(w.land, { interactive: false, renderer, style: { stroke: false, fillColor: '#1f2230', fillOpacity: 1 } }).addTo(map);
      L.geoJSON(w.borders, { interactive: false, renderer, style: { color: '#3a3e52', weight: 0.7, fill: false } }).addTo(map);
    }).catch(() => { /* sem mapa de fundo: os marcadores continuam a aparecer */ });
  }
  try { list = await loadCircuits(); } catch (e) { $('#cList').innerHTML = errorBox('Sem dados de circuitos.', e.message); return; }
  if (!map) simpleMap(list);
  for (const c of list) {
    if (!map) break;
    const icon = L.divIcon({ className: '', html: `<div class="circuit-marker ${c.current ? '' : 'old'}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
    const m = L.marker([c.lat, c.lng], { icon, zIndexOffset: c.current ? 1000 : 0 }).addTo(map).bindPopup(`<b>${esc(c.name)}</b><br>${flagCountry(c.country)} ${esc(c.loc)}, ${esc(c.country)}`);
    m.on('click', () => showCircuit(c));
    markers.set(c.id, m);
  }
  const drawList = () => {
    const qv = $('#cSearch').value.toLowerCase();
    $('#cList').innerHTML = list.filter((c) => !qv || `${c.name} ${c.loc} ${c.country}`.toLowerCase().includes(qv)).map((c) => `<div class="it" data-id="${esc(c.id)}"><span>${flagCountry(c.country)} <b>${esc(c.name)}</b><br><small class="muted">${esc(c.loc)}, ${esc(c.country)}</small></span>${c.current ? `<span class="chip red">R${c.current.round}</span>` : c.races ? `<span class="mono muted" style="font-size:12px">${c.races} GP</span>` : ''}</div>`).join('');
  };
  drawList();
  $('#cSearch').addEventListener('input', drawList);
  $('#cList').addEventListener('click', (e) => { const it = e.target.closest('.it'); if (it) showCircuit(list.find((c) => c.id === it.dataset.id)); });
  const want = qs('c');
  const first = list.find((c) => c.id === want) || list.find((c) => c.current) || list[0];
  if (first) showCircuit(first);
});
