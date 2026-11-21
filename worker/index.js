/**
 * PITWALL — Cloudflare Worker.
 * Os ficheiros do site (pasta htdocs/) são servidos directamente pela Cloudflare.
 * Este código só corre para endereços que não são ficheiros: /api/news, /api/openf1 e /api/live/*.
 */
import { onRequestGet as news } from '../functions/api/news.js';
import { onRequestGet as openf1 } from '../functions/api/openf1.js';
export { LiveTiming } from './livetiming.js';

const ROUTES = { '/api/news': news, '/api/openf1': openf1 };

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // cronometragem oficial em directo: /api/live/ws (WebSocket) e /api/live/state (JSON)
    if (pathname === '/api/live/ws' || pathname === '/api/live/state') {
      if (!env.LIVE) return new Response('Durable Object LIVE não configurado', { status: 503 });
      return env.LIVE.get(env.LIVE.idFromName('f1')).fetch(request);
    }
    const handler = ROUTES[pathname.replace(/\/+$/, '')];
    if (handler) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Método não permitido', { status: 405 });
      return handler({ request, env, waitUntil: (p) => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },
};
