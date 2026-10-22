import { CONFIG } from './config.js';
import { store } from './util.js';

export class ApiError extends Error {}

// Das Tageskontingent von API-Football wird um 00:00 UTC zurückgesetzt.
const utcDay = () => new Date().toISOString().slice(0, 10);

export function getQuota() {
  const q = store.get('quota', null);
  if (!q || q.day !== utcDay()) return { day: utcDay(), used: 0, limit: null, remaining: null };
  return q;
}

function setQuota(patch) {
  store.set('quota', { ...getQuota(), ...patch, day: utcDay() });
}

function readQuotaHeaders(headers) {
  const limit = Number(headers.get('x-ratelimit-requests-limit'));
  const remaining = Number(headers.get('x-ratelimit-requests-remaining'));
  const q = getQuota();
  const patch = { used: q.used + 1 };
  if (limit) patch.limit = limit;
  if (headers.get('x-ratelimit-requests-remaining') !== null && !Number.isNaN(remaining)) {
    patch.remaining = remaining;
  } else if (q.limit) {
    patch.remaining = Math.max(0, (q.remaining ?? q.limit) - 1);
  }
  setQuota(patch);
}

async function call(path, params = {}, { counts = true } = {}) {
  const key = store.get('apiKey', '');
  if (!key) throw new ApiError('Kein API-Key hinterlegt – siehe Einstellungen.');
  const url = new URL(CONFIG.apiBase + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res;
  try {
    res = await fetch(url, { headers: { 'x-apisports-key': key } });
  } catch {
    throw new ApiError('Netzwerkfehler – keine Verbindung zu API-Football.');
  }
  if (counts) readQuotaHeaders(res.headers);
  if (res.status === 429) throw new ApiError('Zu viele Anfragen (Limit erreicht).');
  if (!res.ok) throw new ApiError(`API-Fehler HTTP ${res.status}`);

  const json = await res.json();
  const errs = json.errors;
  const errList = Array.isArray(errs) ? errs : Object.values(errs || {});
  if (errList.length) {
    const msg = errList.join(' ');
    if (/request limit|rateLimit/i.test(msg)) setQuota({ remaining: 0 });
    throw new ApiError(msg);
  }
  return json.response;
}

function cacheGet(name, ttl) {
  const c = store.get('cache:' + name, null);
  return c && Date.now() - c.t < ttl ? c.data : null;
}
const cacheSet = (name, data) => store.set('cache:' + name, { t: Date.now(), data });
export const cacheTime = (name) => store.get('cache:' + name, null)?.t ?? null;

async function cached(name, ttl, force, fn) {
  if (!force) {
    const hit = cacheGet(name, ttl);
    if (hit) return hit;
  }
  try {
    const data = await fn();
    cacheSet(name, data);
    return data;
  } catch (e) {
    // Lieber veraltete Daten zeigen als gar keine.
    const stale = store.get('cache:' + name, null);
    if (stale) { stale.data.__stale = e.message; return stale.data; }
    throw e;
  }
}

function currentSeasonGuess() {
  const d = new Date();
  return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
}

export const apiProvider = {
  name: 'api',

  async getLeague(force = false) {
    const ovId = store.get('leagueId', null);
    const ovSeason = store.get('season', null);
    const league = await cached('league', CONFIG.ttl.league, force, async () => {
      const list = await call('/leagues', { country: CONFIG.country, type: 'league' });
      const hit = list.find((l) => CONFIG.leagueName.test(l.league.name))
        || list.find((l) => /2\.\s*liga/i.test(l.league.name));
      if (!hit) throw new ApiError('2. Liga Österreich nicht in API-Football gefunden.');
      const cur = hit.seasons.find((s) => s.current) || hit.seasons.at(-1);
      return { id: hit.league.id, name: hit.league.name, logo: hit.league.logo, season: cur?.year ?? currentSeasonGuess() };
    });
    return { ...league, id: ovId || league.id, season: ovSeason || league.season };
  },

  async getStandings(league, force = false) {
    return cached(`standings:${league.id}:${league.season}`, CONFIG.ttl.standings, force, async () => {
      const r = await call('/standings', { league: league.id, season: league.season });
      // Bei Ligen mit Gruppen kommen mehrere Tabellen – wir nehmen die erste (Gesamttabelle).
      return { rows: r[0]?.league?.standings?.[0] ?? [] };
    });
  },

  async getFixtures(league, force = false) {
    return cached(`fixtures:${league.id}:${league.season}`, CONFIG.ttl.fixtures, force, async () => {
      const list = await call('/fixtures', { league: league.id, season: league.season, timezone: 'Europe/Vienna' });
      return { list };
    });
  },

  // Liefert inkl. Events (Tore, Karten, Wechsel). Max. 20 IDs pro Anfrage.
  async getFixturesByIds(ids) {
    if (!ids.length) return [];
    return call('/fixtures', { ids: ids.slice(0, 20).join('-'), timezone: 'Europe/Vienna' });
  },

  // /status zählt nicht zum Kontingent.
  async getStatus() {
    const r = await call('/status', {}, { counts: false });
    const req = r?.requests;
    if (req) setQuota({ limit: req.limit_day, remaining: Math.max(0, req.limit_day - req.current) });
    return { plan: r?.subscription?.plan, ends: r?.subscription?.end, ...getQuota() };
  },
};
