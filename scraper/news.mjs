// Sammelt News (2liga.at + RSS-Feeds) und schreibt site/data/news.json.
// Läuft in der GitHub Action nach scraper/build.mjs (nutzt dessen Tabelle für die Teamnamen).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchHtml, parseNews } from '../scraper/lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = ROOT + 'site/data/news.json';
const MAX_AGE_DAYS = 21;
const MAX_ITEMS = 400;

const cfg = JSON.parse(await readFile(ROOT + 'scraper/feeds.json', 'utf8'));

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
    const st = JSON.parse(await readFile(ROOT + 'site/data/standings.json', 'utf8'));
    return st.tables.gesamt.map((r) => r.team.name);
  } catch {
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
try {
  const official = [...parseNews(await fetchHtml('/de/news')), ...parseNews(await fetchHtml('/de'))];
  console.log(`${official.length.toString().padStart(4)}  2liga.at`);
  all.push(...official);
} catch (e) {
  console.warn('FEHLER 2liga.at:', e.message);
}
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
