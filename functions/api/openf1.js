/**
 * PITWALL — proxy para a API OpenF1 (Cloudflare Pages Function).
 * Usado quando o browser não consegue ligar directamente (ex.: Safari, bloqueios de rede/CORS).
 * Uso: /api/openf1?ep=sessions&q=year%3D2025
 * Substitui o antigo api/openf1.php do InfinityFree.
 */
const ALLOWED = new Set(['sessions', 'meetings', 'drivers', 'position', 'intervals', 'laps', 'stints', 'pit',
  'race_control', 'weather', 'team_radio', 'location', 'car_data', 'session_result', 'starting_grid', 'overtakes']);

const json = (obj, status, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extra },
});

/** Quanto tempo guardar a resposta: dados de sessões já terminadas não mudam. */
export function ttlFor(ep, body) {
  if (ep === 'sessions' || ep === 'meetings') return 600;
  const tail = body.slice(-4000);
  const re = /"date(?:_start|_end)?":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/g;
  let last = null, m;
  while ((m = re.exec(tail))) last = m[1];
  if (last) {
    const t = Date.parse(last + 'Z');
    if (t && t < Date.now() - 6 * 3600 * 1000) return 30 * 86400;
  }
  return 20;
}

export async function onRequestGet(context) {
  const { request, waitUntil } = context;
  const url = new URL(request.url);
  const ep = url.searchParams.get('ep') || '';
  const q = url.searchParams.get('q') || '';
  if (!ALLOWED.has(ep) || q.length > 600 || /[\r\n\s#]/.test(q)) return json({ error: 'pedido inválido' }, 400);

  const upstream = `https://api.openf1.org/v1/${ep}${q ? `?${q}` : ''}`;

  // cache da Cloudflare (pode não estar disponível em todos os domínios; nesse caso é ignorada)
  let cache = null;
  const cacheKey = new Request(`https://pitwall-cache.invalid/openf1/${ep}?${q}`);
  try { cache = caches.default; const hit = await cache.match(cacheKey); if (hit) { const r = new Response(hit.body, hit); r.headers.set('X-Cache', 'HIT'); return r; } } catch { cache = null; }

  let res;
  try {
    res = await fetch(upstream, { headers: { Accept: 'application/json', 'User-Agent': 'PitwallFanSite/1.0' } });
  } catch {
    return json({ error: 'OpenF1 inacessível a partir do servidor' }, 502);
  }
  const body = await res.text();
  if (res.status !== 200) {
    return new Response(body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json; charset=utf-8' } });
  }
  const ttl = ttlFor(ep, body);
  const out = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': `public, max-age=${Math.min(ttl, 86400)}`,
      'X-Cache': 'MISS',
    },
  });
  if (cache && body.length < 3_000_000) {
    try { waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttl}` } }))); } catch { /* */ }
  }
  return out;
}
