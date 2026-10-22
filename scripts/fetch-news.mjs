// Sammelt News aus RSS-Feeds und schreibt site/data/news.json.
// Läuft in der GitHub Action (kein CORS-Problem, keine Abhängigkeiten).
// Optional: API_FOOTBALL_KEY → Teamliste holen (max. 1x täglich, gecacht in .cache/teams.json)
// für zusätzliche Team-Suchen und den Filter auf allgemeine Feeds.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = ROOT + 'site/data/news.json';
const TEAMS_CACHE = ROOT + '.cache/teams.json';
const MAX_AGE_DAYS = 21;
const MAX_ITEMS = 400;

const cfg = JSON.parse(await readFile(ROOT + 'scripts/feeds.json', 'utf8'));

const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=de&gl=AT&ceid=AT:de`;

async function getText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (LigaZwa news bot)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENT[e.toLowerCase()] ?? m;
    });
}
const stripTags = (s) => decode(decode(s)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

function parseFeed(xml, fallbackSource) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    let title = stripTags(tag(b, 'title'));
    let link = stripTags(tag(b, 'link'));
    if (!link) link = b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '';
    const date = stripTags(tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'published') || tag(b, 'updated'));
    let source = stripTags(tag(b, 'source')) || fallbackSource;
    let summary = stripTags(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'));
    // Google News: "Titel - Quelle"
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    if (summary.startsWith(title)) summary = summary.slice(title.length).trim();
    if (source && summary.endsWith(source)) summary = summary.slice(0, -source.length).trim();
    if (summary.length > 280) summary = summary.slice(0, 277).replace(/\s+\S*$/, '') + ' …';
    if (!title || !link) continue;
    const t = Date.parse(date);
    items.push({ title, link, source, date: Number.isNaN(t) ? null : new Date(t).toISOString(), summary: summary || null });
  }
  return items;
}

async function loadTeams() {
  try {
    const c = JSON.parse(await readFile(TEAMS_CACHE, 'utf8'));
    if (Date.now() - c.t < 86400e3) return c.teams;
  } catch { /* kein Cache */ }
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return [];
  const api = async (path) => {
    const r = await fetch('https://v3.football.api-sports.io' + path, { headers: { 'x-apisports-key': key } });
    const j = await r.json();
    const errs = Object.values(j.errors || {});
    if (errs.length) throw new Error(errs.join(' '));
    return j.response;
  };
  try {
    const leagues = await api('/leagues?country=Austria&type=league');
    const l = leagues.find((x) => /^2\.\s*liga$/i.test(x.league.name)) || leagues.find((x) => /2\.\s*liga/i.test(x.league.name));
    const season = (l.seasons.find((s) => s.current) || l.seasons.at(-1)).year;
    const teams = (await api(`/teams?league=${l.league.id}&season=${season}`)).map((t) => t.team.name);
    await mkdir(dirname(TEAMS_CACHE), { recursive: true });
    await writeFile(TEAMS_CACHE, JSON.stringify({ t: Date.now(), teams }));
    console.log(`Teams (${teams.length}): ${teams.join(', ')}`);
    return teams;
  } catch (e) {
    console.warn('Teamliste nicht verfügbar:', e.message);
    return [];
  }
}

const teams = await loadTeams();
const keywords = [...cfg.keywords, ...teams].map((k) => k.toLowerCase());
const relevant = (it) => {
  const text = `${it.title} ${it.summary ?? ''}`.toLowerCase();
  return keywords.some((k) => text.includes(k));
};

const jobs = cfg.feeds.map((f) => ({ ...f, url: f.type === 'search' ? gnews(f.q) : f.url }));
if (cfg.perTeamSearch) for (const t of teams) jobs.push({ type: 'search', url: gnews(`"${t}" Fußball`) });

let all = [];
await Promise.all(jobs.map(async (j) => {
  try {
    let items = parseFeed(await getText(j.url), j.name ?? null);
    if (j.filter) items = items.filter(relevant);
    console.log(`${items.length.toString().padStart(4)}  ${j.name ?? j.q ?? j.url}`);
    all.push(...items);
  } catch (e) {
    console.warn(`FEHLER ${j.name ?? j.q ?? j.url}: ${e.message}`);
  }
}));

// Bestehende News behalten, damit kurzzeitig ausfallende Feeds keine Lücken reißen.
try {
  const prev = JSON.parse(await readFile(OUT, 'utf8'));
  all.push(...(prev.items || []));
} catch { /* erster Lauf */ }

const keyOf = (it) => it.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const seen = new Set();
const cutoff = Date.now() - MAX_AGE_DAYS * 86400e3;
const items = all
  .filter((it) => !it.date || Date.parse(it.date) >= cutoff)
  .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
  .filter((it) => { const k = keyOf(it); if (seen.has(k)) return false; seen.add(k); return true; })
  .slice(0, MAX_ITEMS);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), items }, null, 0));
console.log(`→ ${items.length} News geschrieben`);
