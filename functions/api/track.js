/**
 * Traçado de um circuito para o mapa de posições estimadas (Ao Vivo).
 * GET /api/live/track?key=<circuit key da F1>&year=<ano>
 * Fonte: API pública da MultiViewer (a mesma que o FastF1 usa para curvas/rotação),
 * guardada no Workers KV para não voltar a pedir. Coordenadas no mesmo sistema do live timing.
 */
const MV = 'https://api.multiviewer.app/api/v1/circuits';

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const key = parseInt(u.searchParams.get('key'), 10);
  const year = parseInt(u.searchParams.get('year'), 10) || new Date().getUTCFullYear();
  if (!key || key < 1 || key > 9999) return json({ error: 'key inválida' }, 400);

  const kvKey = `track:${key}`;
  const cached = await env.OF1_CACHE?.get(kvKey, 'json').catch(() => null);
  if (cached) return json(cached);

  let last = '';
  for (const y of [year, year - 1, year - 2, year - 3]) {
    try {
      const r = await fetch(`${env.MV_URL || MV}/${key}/${y}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PITWALL fan site)', Accept: 'application/json' } });
      if (!r.ok) { last = `HTTP ${r.status}`; continue; }
      const d = await r.json();
      if (!Array.isArray(d.x) || d.x.length < 20) { last = 'sem traçado'; continue; }
      const out = {
        key, year: y, name: d.circuitName || '', rotation: +d.rotation || 0,
        x: d.x, y: d.y,
        corners: (d.corners || []).map((c) => ({ n: c.number, l: c.letter || '', x: c.trackPosition?.x, y: c.trackPosition?.y })),
      };
      await env.OF1_CACHE?.put(kvKey, JSON.stringify(out)).catch(() => {});
      return json(out);
    } catch (e) { last = String(e.message || e); }
  }
  return json({ error: 'traçado indisponível', detail: last }, 502);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': status === 200 ? 'public, max-age=86400' : 'no-store' },
  });
}
