import { init, $, $$, esc, skeleton, errorBox } from './core.js';
import { FEEDS } from './config.js';
import { loadNews, newsCard } from './news.js';

init(async () => {
  $('#app').innerHTML = `
    <section class="page-hero container"><h1>Notí<em>cias</em></h1><p>O que se passa no paddock, reunido das principais fontes de F1. Actualizado a cada 15 minutos.</p>
      <div class="row-flex mt"><div class="tabs" id="src"><button class="tab active" data-tab="">Todas</button>${FEEDS.map((f) => `<button class="tab" data-tab="${f.id}">${esc(f.name)}</button>`).join('')}</div>
      <input class="input" id="q" placeholder="Pesquisar…" style="min-width:200px;flex:1;max-width:340px"></div></section>
    <section class="section container" style="padding-top:16px"><div class="news-grid" id="grid">${Array(9).fill(`<div class="card">${skeleton(5)}</div>`).join('')}</div><div class="row-flex mt" style="justify-content:center"><button class="btn hidden" id="more">Mais notícias</button></div></section>`;
  let items = [];
  try { items = await loadNews(); } catch (e) { $('#grid').innerHTML = errorBox('Não foi possível carregar notícias.', e.message); return; }
  let src = '', shown = 24;
  const draw = () => {
    const qv = $('#q').value.toLowerCase();
    const L = items.filter((i) => (!src || i.sourceId === src) && (!qv || (i.title + ' ' + (i.summary || '')).toLowerCase().includes(qv)));
    $('#grid').innerHTML = L.length ? L.slice(0, shown).map(newsCard).join('') : `<div style="grid-column:1/-1">${errorBox('Nenhuma notícia encontrada.')}</div>`;
    $('#more').classList.toggle('hidden', L.length <= shown);
  };
  $('#src').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (!b) return; $$('#src .tab').forEach((t) => t.classList.toggle('active', t === b)); src = b.dataset.tab; shown = 24; draw(); });
  $('#q').addEventListener('input', () => { shown = 24; draw(); });
  $('#more').addEventListener('click', () => { shown += 24; draw(); });
  draw();
});
