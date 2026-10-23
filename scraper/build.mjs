// Holt Tabelle, Spielplan und Spielberichte von 2liga.at und schreibt site/data/*.json.
// Läuft in der GitHub Action. Vorherige Daten (vom zuletzt veröffentlichten Stand)
// liegen bereits in site/data und werden fortgeschrieben, um 2liga.at zu schonen.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fetchHtml, parseStandings, parseFixtures, parseRoundCount, parseMatch } from './lib.mjs';

const DIR = new URL('../site/data/', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = Date.now() / 1000;

async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(DIR + name, 'utf8')); } catch { return fallback; }
}
const writeJson = (name, data) => writeFile(DIR + name, JSON.stringify(data));

await mkdir(DIR, { recursive: true });
const prevFx = await readJson('fixtures.json', { list: [] });
const prevMatches = await readJson('matches.json', {});

// --- Tabelle ---
const [gesamt, heim, auswaerts] = parseStandings(await fetchHtml('/de/tabelle'));
if (!gesamt?.length) throw new Error('Tabelle leer – hat sich die Seite geändert?');
await writeJson('standings.json', { updated: new Date().toISOString(), tables: { gesamt, heim: heim || [], auswaerts: auswaerts || [] } });
console.log(`Tabelle: ${gesamt.length} Teams`);

// --- Spielplan ---
const currentHtml = await fetchHtml('/de/spielplan');
// Die Seitennavigation zeigt nur einen Ausschnitt der Runden – bei Hin- und Rückrunde
// sind es (Teams − 1) × 2.
const roundCount = Math.max(parseRoundCount(currentHtml), (gesamt.length - 1) * 2);
const current = parseFixtures(currentHtml);
const currentRound = Number(current[0]?.league.round.match(/\d+$/)?.[0]) || 1;

const byRound = new Map();
for (const f of prevFx.list) {
  const r = Number(f.league.round.match(/\d+$/)?.[0]);
  if (!byRound.has(r)) byRound.set(r, []);
  byRound.get(r).push(f);
}
byRound.set(currentRound, current);

// Alle Runden 1x täglich (und beim ersten Lauf), sonst nur die aktuelle ±1.
const fullRefresh = byRound.size < roundCount || new Date().getUTCHours() === 3 && new Date().getUTCMinutes() < 20
  || process.env.FULL_REFRESH === '1';
const rounds = fullRefresh
  ? Array.from({ length: roundCount }, (_, i) => i + 1)
  : [currentRound - 1, currentRound + 1].filter((r) => r >= 1 && r <= roundCount);
for (const r of rounds) {
  if (r === currentRound) continue;
  try {
    byRound.set(r, parseFixtures(await fetchHtml(`/de/spielplan?spieltag=${r}`)));
  } catch (e) {
    console.warn(`Runde ${r}: ${e.message}`);
  }
  await sleep(400);
}

let list = [...byRound.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, fs]) => fs);
console.log(`Spielplan: ${list.length} Spiele in ${byRound.size} Runden (aktuell: ${currentRound}${fullRefresh ? ', komplett neu geladen' : ''})`);

// --- Spielberichte: alle begonnenen Spiele, die noch nicht final gespeichert sind.
// Laufende/aktuelle zuerst, ältere werden schrittweise (max. 20 pro Lauf) nachgeholt.
const season = list.find((f) => f.fixture.season)?.fixture.season;
const matches = {};
for (const [id, m] of Object.entries(prevMatches)) {
  if (m.fixture.season === season) matches[id] = m;
}
const todo = list.filter((f) => f.fixture.timestamp && f.fixture.timestamp < now + 600
  && !['CANC', 'PST'].includes(f.fixture.status.short)
  && matches[f.fixture.id]?.fixture.status.short !== 'FT')
  .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp)
  .slice(0, 20);
for (const f of todo) {
  try {
    const path = `/de/spielbericht/${f.fixture.season}/${f.fixture.id}/matchcenter`;
    matches[f.fixture.id] = parseMatch(await fetchHtml(path), f.fixture.id, f.fixture.season);
  } catch (e) {
    console.warn(`Spiel ${f.fixture.id}: ${e.message}`);
  }
  await sleep(400);
}
console.log(`Spielberichte: ${todo.length} aktualisiert, ${Object.keys(matches).length} gespeichert`);

// Status/Ergebnis aus dem Spielbericht ist genauer als der Spielplan.
list = list.map((f) => {
  const m = matches[f.fixture.id];
  if (!m) return f;
  return { ...f, fixture: { ...f.fixture, status: m.fixture.status, venue: m.fixture.venue, referee: m.fixture.referee }, goals: m.goals, score: m.score, teams: { home: { ...f.teams.home, winner: m.teams.home.winner }, away: { ...f.teams.away, winner: m.teams.away.winner } } };
});

await writeJson('fixtures.json', { updated: new Date().toISOString(), currentRound, roundCount, list });
await writeJson('matches.json', matches);

// config.json (Live-Server-URL) wird vom Workflow gesetzt – sonst leer anlegen.
try { await readFile(DIR + 'config.json'); } catch { await writeJson('config.json', {}); }
