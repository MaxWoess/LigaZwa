// Cloudflare Worker: liefert Live-Daten von 2liga.at als JSON mit CORS-Header.
// Endpunkte (nur diese – kein offener Proxy):
//   GET /match?season=saison-2026-2027&ids=56865,56866   → Spielberichte inkl. Ereignissen
//   GET /standings                                       → Tabelle (gesamt)
// Antworten werden kurz zwischengespeichert, damit 2liga.at nicht pro Nutzer abgefragt wird.

import { fetchHtml, parseMatch, parseStandings } from '../scraper/lib.mjs';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'content-type': 'application/json; charset=utf-8',
};

const json = (data, status = 200, maxAge = 15) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'cache-control': `public, max-age=${maxAge}` } });

async function cached(ctx, key, ttl, fn) {
  const cache = caches.default;
  const req = new Request('https://cache.ligazwa/' + key);
  const hit = await cache.match(req);
  if (hit) return hit.json();
  const data = await fn();
  ctx.waitUntil(cache.put(req, new Response(JSON.stringify(data), { headers: { 'cache-control': `public, max-age=${ttl}` } })));
  return data;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/match') {
        const season = url.searchParams.get('season') || '';
        if (!/^saison-\d{4}-\d{4}$/.test(season)) return json({ error: 'season fehlt' }, 400);
        const ids = (url.searchParams.get('ids') || '').split(',').map(Number).filter((n) => n > 0).slice(0, 10);
        const list = await Promise.all(ids.map((id) => cached(ctx, `m/${id}`, 20, async () =>
          parseMatch(await fetchHtml(`/de/spielbericht/${season}/${id}/matchcenter`), id, season))));
        return json({ updated: new Date().toISOString(), list });
      }
      if (url.pathname === '/standings') {
        const rows = await cached(ctx, 'standings', 60, async () => parseStandings(await fetchHtml('/de/tabelle'))[0] || []);
        return json({ updated: new Date().toISOString(), rows }, 200, 60);
      }
      return json({ ok: true, endpoints: ['/match?season=&ids=', '/standings'] });
    } catch (e) {
      return json({ error: e.message }, 502, 5);
    }
  },
};
