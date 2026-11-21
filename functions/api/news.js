/**
 * PITWALL — proxy de notícias RSS (Cloudflare Pages Function).
 * Uso: /api/news?feeds=f1,autosport
 * Só aceita os feeds da lista abaixo (evita uso como proxy aberto).
 * Substitui o antigo api/news.php do InfinityFree. Devolve o mesmo formato:
 *   { updated, items: [{title, link, date, image, summary, source, sourceId}], errors }
 */
const CACHE_TTL = 900; // 15 minutos
const MAX_PER_FEED = 25;
export const FEEDS = {
  f1: ['Formula1.com', 'https://www.formula1.com/en/latest/all.xml'],
  autosport: ['Autosport', 'https://www.autosport.com/rss/f1/news/'],
  motorsport: ['Motorsport.com', 'https://www.motorsport.com/rss/f1/news/'],
  therace: ['The Race', 'https://www.the-race.com/formula-1/feed/'],
  racefans: ['RaceFans', 'https://www.racefans.net/feed/'],
  bbc: ['BBC Sport', 'https://feeds.bbci.co.uk/sport/formula1/rss.xml'],
};

// ---------- leitura simples de RSS/Atom (os Workers não têm DOMParser) ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', eacute: 'é', euro: '€', pound: '£' };
export function decode(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const unCdata = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
/** Texto puro: tira CDATA, tags e entidades. */
export function text(s) {
  let t = unCdata(s);
  t = decode(t);                    // entidades primeiro (descrições vêm muitas vezes com &lt;p&gt;)
  t = t.replace(/<[^>]*>/g, ' ');
  t = decode(t);
  return t.replace(/\s+/g, ' ').trim();
}
const esc = (n) => n.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
/** Conteúdo bruto da primeira tag <name>…</name> (com ou sem atributos). */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`, 'i'));
  return m ? m[1] : '';
}
/** Atributo de uma tag (pode ser auto-fechada). */
function attr(xml, name, a) {
  const re = new RegExp(`<${esc(name)}\\b([^>]*)>`, 'gi');
  let m;
  while ((m = re.exec(xml))) {
    const v = m[1].match(new RegExp(`\\b${a}\\s*=\\s*["']([^"']*)["']`, 'i'));
    if (v) return { value: decode(v[1]), attrs: m[1] };
  }
  return null;
}
const firstImg = (html) => { const m = decode(unCdata(html)).match(/<img[^>]+src=["']([^"']+)/i); return m ? m[1] : null; };

export function parseFeed(xml, id, name) {
  const out = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const it of blocks) {
    let link = text(tag(it, 'link'));
    if (!link) { const l = attr(it, 'link', 'href'); if (l) link = l.value; }
    const desc = tag(it, 'description') || tag(it, 'summary');
    const content = tag(it, 'content:encoded') || tag(it, 'content');
    let img = null;
    const mc = attr(it, 'media:content', 'url'); if (mc) img = mc.value;
    if (!img) { const mt = attr(it, 'media:thumbnail', 'url'); if (mt) img = mt.value; }
    if (!img) {
      const en = attr(it, 'enclosure', 'url');
      if (en) { const t = en.attrs.match(/\btype\s*=\s*["']([^"']*)["']/i); if (!t || t[1].startsWith('image')) img = en.value; }
    }
    if (!img) img = firstImg(content || desc);
    const dateStr = text(tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated') || tag(it, 'dc:date'));
    const ts = dateStr ? Date.parse(dateStr) : NaN;
    out.push({
      title: text(tag(it, 'title')), link,
      date: Number.isFinite(ts) ? new Date(ts).toISOString().replace('.000Z', '+00:00') : null,
      image: img || null,
      summary: [...text(desc)].slice(0, 280).join(''),
      source: name, sourceId: id,
    });
    if (out.length >= MAX_PER_FEED) break;
  }
  return out;
}

// ---------- pedido ----------
async function getFeed(id, waitUntil) {
  const [name, url] = FEEDS[id];
  const key = new Request(`https://pitwall-cache.invalid/news/${id}`);
  let cache = null;
  try { cache = caches.default; const hit = await cache.match(key); if (hit) return { items: await hit.json() }; } catch { cache = null; }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PitwallNews/1.0)', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseFeed(await res.text(), id, name);
    if (!items.length) throw new Error('feed vazio');
    if (cache) {
      try { waitUntil(cache.put(key, new Response(JSON.stringify(items), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` } }))); } catch { /* */ }
    }
    return { items };
  } catch {
    return { items: [], error: `${id}: indisponível` };
  }
}

export async function onRequestGet(context) {
  const { request, waitUntil } = context;
  const url = new URL(request.url);
  const req = url.searchParams.has('feeds') ? url.searchParams.get('feeds').split(',') : Object.keys(FEEDS);
  let ids = [...new Set(req.map((s) => s.trim()))].filter((id) => FEEDS[id]);
  if (!ids.length) ids = Object.keys(FEEDS);

  const results = await Promise.all(ids.map((id) => getFeed(id, waitUntil)));
  const all = results.flatMap((r) => r.items);
  const errors = results.filter((r) => r.error).map((r) => r.error);
  all.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  return new Response(JSON.stringify({ updated: new Date().toISOString().replace(/\.\d+Z$/, '+00:00'), items: all, errors }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' },
  });
}
