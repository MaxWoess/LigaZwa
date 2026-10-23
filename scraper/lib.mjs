// Parser für www.2liga.at. Wird von der GitHub Action (scraper/build.mjs) und vom
// Cloudflare Worker (worker/index.mjs) genutzt.
// Die Ausgabe ist an das Format der App angelehnt (fixture/teams/goals/events).

import { parse } from 'node-html-parser';

export const BASE = 'https://www.2liga.at';
export const UA = 'Mozilla/5.0 (compatible; LigaZwa private app)';

export async function fetchHtml(path, fetchImpl = fetch) {
  const res = await fetchImpl(BASE + path, { headers: { 'user-agent': UA, 'accept-language': 'de' } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

const txt = (el) => (el ? el.text.replace(/\s+/g, ' ').trim() : '');

// Alle sichtbaren Textstücke eines Elements in Dokumentreihenfolge.
function textTokens(el, out = []) {
  for (const c of el.childNodes) {
    if (c.nodeType === 3) {
      const t = c.text.replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    } else if (c.nodeType === 1 && !['script', 'style', 'title'].includes(c.rawTagName?.toLowerCase())) {
      textTokens(c, out);
    }
  }
  return out;
}
const num = (s) => {
  const d = String(s ?? '').replace(/[^\d-]/g, '');
  return d && Number.isFinite(Number(d)) ? Number(d) : null;
};

// Next.js-Bild-URLs → Original-URL (S3), damit die App nicht über 2liga.at gehen muss.
function imgUrl(img) {
  const src = img?.getAttribute('src') || '';
  const m = src.match(/[?&]url=([^&]+)/);
  if (m) return decodeURIComponent(m[1]).replace(/\?timestamp=\d+$/, '');
  return src.startsWith('/') ? BASE + src : src;
}

function teamFromLink(a, root) {
  const href = a.getAttribute('href') || '';
  const m = href.match(/\/team\/[^/]+\/(\d+)/);
  if (!m) return null;
  const id = Number(m[1]);
  const img = root.querySelectorAll(`a[href="${href}"] img`)[0] || a.querySelector('img');
  return { id, name: img?.getAttribute('alt') || txt(a), logo: imgUrl(img) };
}

// --- Zeit -------------------------------------------------------------------

function viennaOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Vienna', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).reduce((o, p) => ((o[p.type] = p.value), o), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - utcMs;
}

// "31.07.2026", "18:30" (Wiener Zeit) → Unix-Sekunden
export function viennaToUnix(date, time = '00:00') {
  const [d, m, y] = date.split('.').map(Number);
  const [h, mi] = (time.match(/\d{1,2}:\d{2}/)?.[0] || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - viennaOffsetMs(guess);
  t = guess - viennaOffsetMs(t);
  return Math.round(t / 1000);
}

// --- Tabelle ----------------------------------------------------------------

// Liefert die drei Tabellen der Seite (gesamt, heim, auswärts).
export function parseStandings(html) {
  const root = parse(html);
  return root.querySelectorAll('table').map((table) => {
    const head = table.querySelectorAll('th').map(txt);
    const col = (name) => head.indexOf(name);
    const idx = {
      rank: col('PL'), played: col('Spiele'), w: col('S'), d: col('U'), l: col('N'),
      gf: col('Tore'), ga: col('GT'), gd: col('TD'), pts: col('Punkte'),
    };
    return table.querySelectorAll('tbody tr').map((tr) => {
      const tds = tr.querySelectorAll('td');
      const a = tr.querySelector('a[href*="/team/"]');
      if (!a || tds.length < 8) return null;
      const team = teamFromLink(a, tr);
      team.abbr = txt(tr.querySelectorAll('a[href*="/team/"] p')[0]) || null;
      const v = (k) => num(txt(tds[idx[k]]));
      return {
        rank: v('rank'), team, points: v('pts'), goalsDiff: v('gd'), form: '', description: null,
        all: { played: v('played'), win: v('w'), draw: v('d'), lose: v('l'), goals: { for: v('gf'), against: v('ga') } },
      };
    }).filter(Boolean);
  }).filter((t) => t.length);
}

// --- Spielplan --------------------------------------------------------------

export function parseRoundCount(html) {
  const pages = [...html.matchAll(/aria-label="Page (\d+)"/g)].map((m) => Number(m[1]));
  return pages.length ? Math.max(...pages) : 0;
}

export function parseFixtures(html) {
  const root = parse(html);
  const out = [];
  for (const tr of root.querySelectorAll('tbody tr')) {
    const link = tr.querySelector('a[href*="/spielbericht/"]');
    const teams = tr.querySelectorAll('td').map((td) => td.querySelector('a[href*="/team/"]')).filter(Boolean);
    if (!link || teams.length < 2) continue;
    const [, season, idStr] = link.getAttribute('href').match(/\/spielbericht\/([^/]+)\/(\d+)/) || [];
    const id = Number(idStr);
    const texts = tr.querySelectorAll('td').map(txt);
    const round = num(texts[0]);
    const date = texts.find((t) => /^\d{2}\.\d{2}\.\d{4}$/.test(t));
    const time = texts.find((t) => /^\d{1,2}:\d{2}$/.test(t)) || '00:00';
    const scoreTd = tr.querySelectorAll('td').find((td) => /\d+\s*:\s*\d+|-\s*:\s*-/.test(txt(td)) && !/^\d{1,2}:\d{2}$/.test(txt(td)));
    const ps = scoreTd ? scoreTd.querySelectorAll('p').map(txt) : [];
    const sc = (ps[0] || '').match(/(\d+)\s*:\s*(\d+)/);
    const ht = (ps[1] || '').match(/(\d+)\s*:\s*(\d+)/);
    const home = teamFromLink(teams[0], tr), away = teamFromLink(teams[1], tr);
    home.abbr = txt(teams[0].parentNode.querySelectorAll('p')[0]) || null;
    away.abbr = txt(teams[1].parentNode.querySelectorAll('p')[0]) || null;
    out.push(makeFixture({
      id, season, round, timestamp: date ? viennaToUnix(date, time) : null, timeTbd: !date,
      home, away, goals: sc ? [Number(sc[1]), Number(sc[2])] : null, ht: ht ? [Number(ht[1]), Number(ht[2])] : null,
      // Ergebnis im Spielplan ⇒ Spiel zumindest begonnen; "beendet" erst, wenn es eine Halbzeit-Angabe gibt und der Anpfiff > 2,5 h her ist
    }));
  }
  return out;
}

function statusFor({ statusText, timestamp, goals }) {
  const s = (statusText || '').toLowerCase();
  const now = Date.now() / 1000;
  if (/abgesagt/.test(s)) return { short: 'CANC', long: statusText };
  if (/verschoben/.test(s)) return { short: 'PST', long: statusText };
  if (/abgebrochen/.test(s)) return { short: 'ABD', long: statusText };
  if (/beendet|spielende|endstand|ende$/.test(s)) return { short: 'FT', long: statusText };
  if (/halbzeit|pause/.test(s) && !/\d\.\s*halbzeit/.test(s)) return { short: 'HT', long: statusText };
  if (/live|\d+'|\d\.\s*halbzeit|läuft/.test(s)) return { short: 'LIVE', long: statusText };
  if (!timestamp || now < timestamp) return { short: 'NS', long: statusText || 'Not Started' };
  // Ohne Statustext: über die Zeit entscheiden
  if (now > timestamp + 2.5 * 3600 && goals) return { short: 'FT', long: 'Beendet' };
  if (now > timestamp + 3 * 3600) return { short: goals ? 'FT' : 'NS', long: statusText };
  return { short: 'LIVE', long: statusText || 'Live' };
}

function makeFixture({ id, season, round, timestamp, timeTbd, home, away, goals, ht, statusText, elapsed, venue, referee, attendance }) {
  const status = timeTbd ? { short: 'TBD', long: 'Termin offen' } : statusFor({ statusText, timestamp, goals });
  const final = status.short === 'FT';
  const g = goals || [null, null];
  return {
    fixture: {
      id, season: season || null, timestamp, referee: referee || null, attendance: attendance ?? null,
      venue: { name: venue || null },
      status: { ...status, elapsed: elapsed ?? null, extra: null },
    },
    league: { round: `Regular Season - ${round}` },
    teams: {
      home: { ...home, winner: final ? (g[0] > g[1] ? true : g[0] < g[1] ? false : null) : null },
      away: { ...away, winner: final ? (g[1] > g[0] ? true : g[1] < g[0] ? false : null) : null },
    },
    goals: { home: g[0], away: g[1] },
    score: { halftime: { home: ht?.[0] ?? null, away: ht?.[1] ?? null } },
  };
}

// --- Matchcenter ------------------------------------------------------------

const EVENT_TYPES = {
  'Tor': ['Goal', 'Normal Goal'],
  'Elfmetertor': ['Goal', 'Penalty'],
  'Elfmeter': ['Goal', 'Penalty'],
  'Eigentor': ['Goal', 'Own Goal'],
  'Elfmeter verschossen': ['Goal', 'Missed Penalty'],
  'Gelbe Karte': ['Card', 'Yellow Card'],
  'Gelb-Rote Karte': ['Card', 'Second Yellow card'],
  'Rote Karte': ['Card', 'Red Card'],
  'Wechsel': ['subst', 'Substitution'],
  'Einwechslung': ['subst', 'Substitution'],
  'Auswechslung': ['subst', 'Substitution'],
  'VAR': ['Var', 'VAR'],
};

function hasClass(el, part) {
  return (el.getAttribute?.('class') || '').includes(part);
}

export function parseMatch(html, id, season = null) {
  const root = parse(html);
  const main = root.querySelector('main') || root;
  const tokens = textTokens(main);
  // Kopfbereich bis zur Navigation (Info | Vorbericht | Matchcenter …)
  const navAt = tokens.findIndex((t, i) => t === 'Info' && /Vorbericht|Matchcenter/.test(tokens[i + 1] || ''));
  const head = tokens.slice(0, navAt > 0 ? navAt : 30);

  const round = num(head[head.indexOf('Runde') + 1]);
  const date = head.map((t) => t.match(/\d{2}\.\d{2}\.\d{4}/)?.[0]).find(Boolean);
  const time = head.find((t) => /^\d{1,2}:\d{2}$/.test(t));
  const scoreIdx = head.findIndex((t) => /^\d+\s*:\s*\d+$/.test(t) && t !== time);
  const sc = scoreIdx >= 0 ? head[scoreIdx].match(/(\d+)\s*:\s*(\d+)/) : null;
  const ht = head.map((t) => t.match(/^\((\d+)\s*:\s*(\d+)\)$/)).find(Boolean);

  // Stadion/SR/Zuschauer stehen jeweils nach einem Icon mit <title> – nur im Kopfbereich suchen,
  // weiter unten (Vorbericht) kommen dieselben Icons für frühere Duelle vor.
  const navPos = html.search(/>(Vorbericht|Matchcenter)</);
  const headRoot = parse(navPos > 0 ? html.slice(0, navPos) : html);
  const afterIcon = (title) => {
    const svg = headRoot.querySelectorAll('svg').find((s) => txt(s.querySelector('title')) === title);
    let el = svg;
    for (let i = 0; i < 4 && el; i++) {
      el = el.parentNode;
      const t = txt(el).replace(title, '').trim();
      if (t) return t;
    }
    return null;
  };
  const venue = afterIcon('Stadion');
  const referee = afterIcon('Schiedsrichter');
  const attendance = num(afterIcon('Zuschaueranzahl'));

  const KNOWN = /Beendet|Live|Halbzeit|Pause|Spielende|Abgesagt|Verschoben|Abgebrochen|läuft|^\d+'(\+\d+)?$/i;
  const statusText = head.slice(scoreIdx >= 0 ? scoreIdx : 0).find((t) => KNOWN.test(t)) || '';

  const teamLinks = [];
  for (const a of main.querySelectorAll('a[href*="/team/"]')) {
    const t = teamFromLink(a, main);
    if (t && !teamLinks.some((x) => x.id === t.id)) teamLinks.push(t);
    if (teamLinks.length === 2) break;
  }
  const [home, away] = teamLinks.length === 2 ? teamLinks
    : [{ id: null, name: head[scoreIdx - 2] }, { id: null, name: head[scoreIdx + 2] }];

  // Ereignisse: Zeilen im 3-Spalten-Grid (Heim | Minute | Auswärts)
  const events = [];
  for (const row of main.querySelectorAll('div')) {
    if (!hasClass(row, 'grid-cols-[minmax(0,1fr),auto,minmax(0,1fr)]')) continue;
    const minuteBox = row.childNodes.find((c) => hasClass(c, 'col-start-2'));
    const sideBox = row.childNodes.find((c) => hasClass(c, 'col-start-1') || hasClass(c, 'col-start-3'));
    if (!minuteBox || !sideBox) continue;
    const mt = txt(minuteBox).replace(/\s/g, '');
    const m = mt.match(/^(\d+)'?(?:\+(\d+))?/);
    if (!m) continue;
    const title = txt(sideBox.querySelector('svg title'));
    const [type, detail] = EVENT_TYPES[title] || ['Other', title];
    const players = sideBox.querySelectorAll('a[href*="/spieler/"] p').map(txt).filter(Boolean);
    const isHome = hasClass(sideBox, 'col-start-1');
    events.push({
      time: { elapsed: Number(m[1]), extra: m[2] ? Number(m[2]) : null },
      team: { id: isHome ? home.id : away.id, name: isHome ? home.name : away.name },
      player: { name: players[0] || null },
      // Bei Wechseln: erster Name = eingewechselt, zweiter = ausgewechselt (siehe Seite)
      assist: { name: players[1] || null },
      type, detail, side: isHome ? 'home' : 'away',
    });
  }
  // Wechsel in App-Logik: player = raus, assist = rein
  for (const e of events) if (e.type === 'subst') [e.player.name, e.assist.name] = [e.assist.name ?? e.player.name, e.assist.name ? e.player.name : null];
  events.sort((a, b) => a.time.elapsed - b.time.elapsed || (a.time.extra ?? 0) - (b.time.extra ?? 0));

  // Teamstatistiken: Wert | Bezeichnung | Wert
  const stats = [];
  const si = tokens.indexOf('Teamstatistiken');
  const ei = tokens.indexOf('Aufstellung', si);
  if (si >= 0) {
    const seg = tokens.slice(si + 1, ei > si ? ei : si + 60);
    for (let i = 0; i + 2 < seg.length; i++) {
      if (/^[\d.,]+%?$/.test(seg[i]) && /[A-Za-zÄÖÜäöü]/.test(seg[i + 1]) && /^[\d.,]+%?$/.test(seg[i + 2])) {
        stats.push({ type: seg[i + 1], home: seg[i], away: seg[i + 2] });
        i += 2;
      }
    }
  }

  const last = events.at(-1);
  const goals = sc ? [Number(sc[1]), Number(sc[2])] : null;
  const timestamp = date ? viennaToUnix(date, time) : null;
  const f = makeFixture({
    id, season, round, timestamp, home, away, goals, ht: ht ? [Number(ht[1]), Number(ht[2])] : null,
    statusText, venue, referee, attendance,
  });
  if (['LIVE', 'HT'].includes(f.fixture.status.short)) {
    const lm = statusText.match(/^(\d+)'/);
    const est = Math.floor((Date.now() / 1000 - timestamp) / 60);
    // Grobe Schätzung inkl. 15 Min. Pause, falls die Seite keine Minute anzeigt
    f.fixture.status.elapsed = lm ? Number(lm[1]) : Math.max(last?.time.elapsed ?? 0, Math.min(90, est > 60 ? est - 15 : Math.min(45, est)));
  }
  f.events = events;
  f.statistics = stats;
  return f;
}

// --- News -------------------------------------------------------------------

export function parseNews(html) {
  const root = parse(html);
  const images = new Map();
  for (const a of root.querySelectorAll('a[href*="/news/artikel/"]')) {
    const img = a.querySelector('img');
    if (img) images.set(a.getAttribute('href').replace(/^\/de/, ''), imgUrl(img));
  }
  const items = [];
  for (const s of root.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try { data = JSON.parse(s.text); } catch { continue; }
    for (const n of [].concat(data).flatMap((d) => d.relatedLink || [])) {
      if (!n.url || !n.headline) continue;
      const path = new URL(n.url).pathname.replace(/^\/de/, '');
      items.push({ title: n.headline, link: n.url, source: '2liga.at', date: n.datePublished || null, summary: null, image: images.get(path) || null });
    }
  }
  // Artikel, die nur als Link (ohne JSON-LD) auf der Seite stehen
  const known = new Set(items.map((i) => i.link));
  for (const a of root.querySelectorAll('a[href*="/news/artikel/"]')) {
    const path = a.getAttribute('href').replace(/^\/de/, '');
    const link = BASE + '/de' + path;
    const title = textTokens(a).sort((x, y) => y.length - x.length)[0] || '';
    if (known.has(link) || title.length < 15) continue;
    known.add(link);
    items.push({ title, link, source: '2liga.at', date: null, summary: null, image: images.get(path) || null });
  }
  return items;
}
