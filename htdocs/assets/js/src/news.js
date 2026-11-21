// Notícias: proxy do site (Cloudflare) com cache; alternativa rss2json no browser.
import { CONFIG, FEEDS } from './config.js';
import { getJSON, esc, fmt } from './core.js';

function clean(s) { const d = document.createElement('div'); d.innerHTML = s || ''; return (d.textContent || '').replace(/\s+/g, ' ').trim(); }
function firstImg(html) { const m = /<img[^>]+src=["']([^"']+)/i.exec(html || ''); return m ? m[1] : null; }

async function viaProxy(ids) {
  const data = await getJSON(`${CONFIG.newsProxy}?feeds=${ids.join(',')}`, { ttl: 600, retries: 0 });
  if (!data || !Array.isArray(data.items)) throw new Error('proxy sem itens');
  return data.items;
}
async function viaRss2json(feeds) {
  const res = await Promise.allSettled(feeds.map(async (f) => {
    const d = await getJSON(CONFIG.rss2json + encodeURIComponent(f.url), { ttl: 900, retries: 0 });
    return (d.items || []).map((it) => ({
      title: clean(it.title), link: it.link, date: it.pubDate ? it.pubDate.replace(' ', 'T') + 'Z' : null,
      image: it.enclosure?.link || it.thumbnail || firstImg(it.content || it.description),
      summary: clean(it.description).slice(0, 280), source: f.name, sourceId: f.id,
    }));
  }));
  return res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

export async function loadNews(ids = FEEDS.map((f) => f.id)) {
  let items = [];
  if (location.protocol !== 'file:') try { items = await viaProxy(ids); } catch (e) { console.warn('Proxy de notícias indisponível, a usar rss2json', e); }
  if (!items.length) items = await viaRss2json(FEEDS.filter((f) => ids.includes(f.id)));
  const seen = new Set();
  return items
    .filter((i) => i.title && i.link && !seen.has(i.link) && seen.add(i.link))
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

export function newsCard(it) {
  const img = it.image ? `style="background-image:url('${esc(it.image)}')"` : '';
  return `<a class="news-card fade-in" href="${esc(it.link)}" target="_blank" rel="noopener">
    <div class="img ${it.image ? '' : 'ph'}" ${img}><span class="src chip">${esc(it.source)}</span></div>
    <div class="body"><h3>${esc(it.title)}</h3>${it.summary ? `<p>${esc(it.summary)}</p>` : ''}<div class="meta">${it.date ? esc(fmt.rel(it.date)) : ''}</div></div>
  </a>`;
}
export function newsRow(it) {
  return `<a class="item" href="${esc(it.link)}" target="_blank" rel="noopener">
    <div class="th" ${it.image ? `style="background-image:url('${esc(it.image)}')"` : ''}></div>
    <div><h4>${esc(it.title)}</h4><div class="meta">${esc(it.source)} · ${it.date ? esc(fmt.rel(it.date)) : ''}</div></div></a>`;
}
