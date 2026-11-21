/**
 * PITWALL — Cloudflare Worker.
 * Os ficheiros do site (pasta htdocs/) são servidos directamente pela Cloudflare.
 * Este código só corre para endereços que não são ficheiros: /api/news e /api/openf1.
 */
import { onRequestGet as news } from '../functions/api/news.js';
import { onRequestGet as openf1 } from '../functions/api/openf1.js';

const ROUTES = { '/api/news': news, '/api/openf1': openf1 };

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const handler = ROUTES[pathname.replace(/\/+$/, '')];
    if (handler) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Método não permitido', { status: 405 });
      return handler({ request, env, waitUntil: (p) => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },
};
