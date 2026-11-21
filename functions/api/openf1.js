/**
 * PITWALL — proxy para a API OpenF1 (Cloudflare Worker).
 * Usado quando o browser não consegue ligar directamente (ex.: Safari, bloqueios de rede/CORS).
 * Uso: /api/openf1?ep=sessions&q=year%3D2025
 *
 * Se existir o armazenamento KV "OF1_CACHE" (ver wrangler.jsonc), guarda uma cópia:
 *  - dados de sessões já terminadas: guardados para sempre (não mudam);
 *  - listas de sessões/GP: renovadas a cada 10 minutos.
 * Assim, nos fins-de-semana de corrida, quando a OpenF1 fecha a API a quem não paga,
 * o replay de sessões antigas continua a funcionar com a cópia guardada.
 */
const ALLOWED = new Set(['sessions', 'meetings', 'drivers', 'position', 'intervals', 'laps', 'stints', 'pit',
  'race_control', 'weather', 'team_radio', 'location', 'car_data', 'session_result', 'starting_grid', 'overtakes']);
const KV_MAX = 24 * 1024 * 1024; // limite do KV é 25 MiB por valor
const LIST_TTL = 600;            // sessions/meetings: 10 minutos

const JSON_CT = 'application/json; charset=utf-8';
const json = (obj, status, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': JSON_CT, 'X-Content-Type-Options': 'nosniff', ...extra },
});
const ok = (body, cacheState, maxAge) => new Response(body, {
  status: 200,
  headers: { 'Content-Type': JSON_CT, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': `public, max-age=${maxAge}`, 'X-Cache': cacheState },
});

/** Quanto tempo a resposta é válida (s): dados de sessões terminadas não mudam. */
export function ttlFor(ep, body) {
  if (ep === 'sessions' || ep === 'meetings') return LIST_TTL;
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
  const { request, waitUntil, env } = context;
  const kv = env && env.OF1_CACHE;
  const url = new URL(request.url);
  const ep = url.searchParams.get('ep') || '';
  const q = url.searchParams.get('q') || '';
  if (!ALLOWED.has(ep) || q.length > 600 || /[\r\n\s#]/.test(q)) return json({ error: 'pedido inválido' }, 400);

  const key = `${ep}?${q}`;
  const isList = ep === 'sessions' || ep === 'meetings';

  // 1) cópia guardada
  let stored = null;
  if (kv) {
    try { stored = await kv.getWithMetadata(key); } catch { stored = null; }
    if (stored && stored.value !== null) {
      const age = (Date.now() - (stored.metadata?.t || 0)) / 1000;
      if (!isList || age < LIST_TTL) return ok(stored.value, 'HIT', isList ? LIST_TTL : 86400);
    } else stored = null;
  }

  // 2) OpenF1
  let res = null, body = '';
  try {
    res = await fetch(`https://api.openf1.org/v1/${ep}${q ? `?${q}` : ''}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'PitwallFanSite/1.0' },
    });
    body = await res.text();
  } catch { res = null; }

  if (res && res.status === 200) {
    const ttl = ttlFor(ep, body);
    if (kv && (isList || ttl >= 86400) && body.length < KV_MAX && body.trim().startsWith('[') && body.trim() !== '[]') {
      const put = kv.put(key, body, { metadata: { t: Date.now() } }).catch(() => { /* limite diário de escrita, etc. */ });
      try { waitUntil(put); } catch { /* */ }
    }
    return ok(body, 'MISS', Math.min(ttl, 86400));
  }

  // 3) OpenF1 recusou ou falhou: serve a cópia antiga, se houver
  if (stored) return ok(stored.value, 'STALE', 60);
  if (!res) return json({ error: 'OpenF1 inacessível a partir do servidor' }, 502);
  return new Response(body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || JSON_CT } });
}
