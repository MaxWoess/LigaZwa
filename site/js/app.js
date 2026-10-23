import { CONFIG } from './config.js';
import { $, $$, esc, store, fmtDay, fmtTime, fmtLongDate, dayKey, timeAgo, countdown, norm } from './util.js';

const FINAL = new Set(['FT', 'AET', 'PEN', 'PST', 'CANC', 'ABD', 'AWD', 'WO']);
const IN_PLAY = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']);
const ROUTES = ['tabelle', 'spielplan', 'live', 'news'];
const TABLES = { gesamt: 'Gesamt', heim: 'Heim', auswaerts: 'Auswärts' };

const S = {
  config: {},
  season: null,
  tables: { gesamt: [], heim: [], auswaerts: [] },
  standings: [],
  fixtures: [],
  byId: new Map(),
  events: new Map(),
  stats: new Map(),
  news: null,
  updated: null,
  error: null,
  loading: true,
  live: { lastPoll: 0, polling: false, error: null, interval: null, seen: new Set() },
  ui: {
    round: null,
    table: store.get('tableView', 'gesamt'),
    team: store.get('fixtureTeam', ''),
    newsTeams: store.get('newsTeams', []),
  },
};

// ---------- Helpers ----------

const ko = (f) => f.fixture.timestamp * 1000;
const st = (f) => f.fixture.status.short;
const isFinal = (f) => FINAL.has(st(f));
const isLive = (f) => IN_PLAY.has(st(f));
const favId = () => store.get('favorite', null);
const roundNo = (r) => Number(String(r).match(/(\d+)\s*$/)?.[1] ?? 0);
const roundLabel = (r) => (roundNo(r) ? `${roundNo(r)}. Runde` : r);
const liveUrl = () => (store.get('liveUrl', '') || S.config.liveUrl || '').replace(/\/+$/, '');
const seasonLabel = () => {
  const m = S.season?.match(/(\d{4})-(\d{4})/);
  return m ? `${m[1]}/${m[2].slice(-2)}` : '';
};
const reportUrl = (f) => `https://www.2liga.at/de/spielbericht/${f.fixture.season}/${f.fixture.id}/matchcenter`;

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function teams() {
  if (S.standings.length) return S.standings.map((r) => r.team).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const m = new Map();
  S.fixtures.forEach((f) => { m.set(f.teams.home.id, f.teams.home); m.set(f.teams.away.id, f.teams.away); });
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

const logo = (t, cls = 'logo') => (t?.logo ? `<img class="${cls}" src="${esc(t.logo)}" alt="" loading="lazy">` : `<span class="${cls}"></span>`);

function statusBadge(f) {
  const s = st(f);
  const e = f.fixture.status.elapsed;
  if (s === 'HT') return '<span class="badge live">Pause</span>';
  if (IN_PLAY.has(s)) return `<span class="badge live">${e ? `${e}'` : 'Live'}</span>`;
  if (s === 'PST') return '<span class="badge">verschoben</span>';
  if (s === 'CANC' || s === 'ABD') return '<span class="badge">abgesagt</span>';
  return '';
}

function scoreCell(f) {
  const s = st(f);
  if (s === 'NS' || s === 'TBD' || s === 'PST' || s === 'CANC' || f.goals.home === null) {
    return `<span class="score pending">${s === 'TBD' ? 'offen' : fmtTime(ko(f))}</span>`;
  }
  return `<span class="score ${isLive(f) ? 'is-live' : ''}">${f.goals.home}:${f.goals.away}</span>`;
}

function matchRow(f, { showDate = true } = {}) {
  const fav = favId();
  const h = f.teams.home, a = f.teams.away;
  const cls = (t) => ['team', t.id === fav ? 'fav' : '', t.winner === true ? 'win' : ''].join(' ');
  return `<button class="match" data-fixture="${f.fixture.id}">
    <span class="meta">${showDate && f.fixture.timestamp ? fmtDay(ko(f)) : ''}${statusBadge(f)}</span>
    <span class="${cls(h)} home"><span class="name">${esc(h.name)}</span>${logo(h)}</span>
    ${scoreCell(f)}
    <span class="${cls(a)} away">${logo(a)}<span class="name">${esc(a.name)}</span></span>
  </button>`;
}

function setFixtures(list) {
  S.fixtures = list.filter((f) => f.fixture.timestamp).sort((x, y) => ko(x) - ko(y))
    .concat(list.filter((f) => !f.fixture.timestamp));
  S.byId = new Map(S.fixtures.map((f) => [f.fixture.id, f]));
  S.season = S.fixtures.find((f) => f.fixture.season)?.fixture.season ?? S.season;
}

function mergeFixture(f) {
  const { events, statistics, ...rest } = f;
  if (events) S.events.set(f.fixture.id, events);
  if (statistics?.length) S.stats.set(f.fixture.id, statistics);
  const old = S.byId.get(f.fixture.id);
  // Spielbericht-Daten haben keine Teamkürzel – vom Spielplan übernehmen
  if (old) {
    rest.teams = { home: { ...old.teams.home, ...rest.teams.home }, away: { ...old.teams.away, ...rest.teams.away } };
    rest.fixture = { ...rest.fixture, timestamp: rest.fixture.timestamp ?? old.fixture.timestamp };
    rest.league = old.league;
  }
  const i = S.fixtures.findIndex((x) => x.fixture.id === f.fixture.id);
  if (i >= 0) S.fixtures[i] = rest; else S.fixtures.push(rest);
  S.byId.set(f.fixture.id, rest);
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------- Daten laden ----------

async function loadAll() {
  S.loading = true;
  S.error = null;
  render();
  const [stR, fxR, mtR, cfR] = await Promise.allSettled([
    getJson('data/standings.json'), getJson('data/fixtures.json'), getJson('data/matches.json'), getJson('data/config.json'),
  ]);
  if (cfR.status === 'fulfilled') S.config = cfR.value || {};
  if (stR.status === 'fulfilled') {
    S.tables = stR.value.tables;
    S.standings = S.tables.gesamt;
  }
  if (fxR.status === 'fulfilled') {
    setFixtures(fxR.value.list);
    S.updated = fxR.value.updated;
  }
  if (mtR.status === 'fulfilled') {
    for (const m of Object.values(mtR.value)) mergeFixture(m);
  }
  if (stR.status === 'rejected' || fxR.status === 'rejected') {
    S.error = 'Noch keine Daten vorhanden. Der GitHub-Workflow „Deploy & Daten“ muss einmal gelaufen sein.';
  }
  S.loading = false;
  render();
  tick();
}

async function refreshStandings() {
  try {
    if (liveUrl()) {
      const r = await getJson(`${liveUrl()}/standings`);
      if (r.rows?.length) { S.tables.gesamt = r.rows; S.standings = r.rows; }
    } else {
      const r = await getJson('data/standings.json');
      S.tables = r.tables;
      S.standings = r.tables.gesamt;
    }
    render();
  } catch { /* nächster Versuch beim nächsten Spielende */ }
}

async function loadNews() {
  try {
    S.news = await getJson(CONFIG.newsUrl);
  } catch {
    S.news = { updated: null, items: [] };
  }
  if (route() === 'news') render();
}

// ---------- Live-Ticker ----------

function liveCandidates(now = Date.now()) {
  return S.fixtures.filter((f) => f.fixture.timestamp && !isFinal(f)
    && now >= ko(f) - CONFIG.liveBeforeKickoff
    && now <= ko(f) + CONFIG.liveMaxWindow);
}

// Mit Live-Server: eingestelltes Intervall. Ohne: die Daten auf GitHub ändern sich
// nur alle ~15 Min., öfter nachzusehen bringt nichts.
function computeInterval() {
  const user = Math.max(CONFIG.minInterval, Number(store.get('interval', CONFIG.defaultInterval)) || CONFIG.defaultInterval);
  return liveUrl() ? user : Math.max(user, CONFIG.fallbackInterval);
}

function notifyGoal(prev, next) {
  const before = (prev?.goals.home ?? 0) + (prev?.goals.away ?? 0);
  const after = (next.goals.home ?? 0) + (next.goals.away ?? 0);
  if (!S.live.seen.has(next.fixture.id) || after <= before) return;
  const goal = (next.events || []).filter((e) => e.type === 'Goal' && e.detail !== 'Missed Penalty').at(-1);
  const h = S.byId.get(next.fixture.id)?.teams.home.name ?? next.teams.home.name;
  const a = S.byId.get(next.fixture.id)?.teams.away.name ?? next.teams.away.name;
  const title = `⚽ ${h} ${next.goals.home}:${next.goals.away} ${a}`;
  const body = goal ? `${goal.time.elapsed}' ${goal.player?.name ?? ''}` : '';
  toast(`${title} ${body}`);
  const fav = favId();
  if (store.get('notifyFavOnly', false) && fav && next.teams.home.id !== fav && next.teams.away.id !== fav) return;
  if (store.get('notify', false) && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: 'icon.svg', tag: 'goal-' + next.fixture.id }); } catch { /* iOS ohne PWA */ }
  }
}

async function fetchUpdates(cands) {
  if (liveUrl()) {
    const season = cands[0].fixture.season || S.season;
    const r = await getJson(`${liveUrl()}/match?season=${encodeURIComponent(season)}&ids=${cands.map((f) => f.fixture.id).join(',')}`);
    if (r.error) throw new Error(r.error);
    return r.list;
  }
  const [fx, mt] = await Promise.all([getJson('data/fixtures.json'), getJson('data/matches.json')]);
  S.updated = fx.updated;
  const ids = new Set(cands.map((f) => f.fixture.id));
  return fx.list.filter((f) => ids.has(f.fixture.id)).map((f) => mt[f.fixture.id] ?? f);
}

async function poll(cands) {
  S.live.polling = true;
  try {
    const upd = await fetchUpdates(cands);
    let finished = false;
    for (const f of upd) {
      const prev = S.byId.get(f.fixture.id);
      notifyGoal(prev, f);
      if (prev && !isFinal(prev) && FINAL.has(f.fixture.status.short)) finished = true;
      mergeFixture(f);
      S.live.seen.add(f.fixture.id);
    }
    S.live.error = null;
    if (finished) refreshStandings();
  } catch (e) {
    S.live.error = e.message;
  } finally {
    S.live.lastPoll = Date.now();
    S.live.polling = false;
    if (route() === 'live' || route() === 'spielplan') render();
    updateLiveDot();
  }
}

function tick() {
  if (S.loading || S.live.polling || !S.fixtures.length) return;
  if (document.hidden && !store.get('notify', false)) return;
  const cands = liveCandidates();
  updateLiveDot();
  if (!cands.length) { S.live.interval = null; return; }
  S.live.interval = computeInterval();
  if (Date.now() - S.live.lastPoll >= S.live.interval * 1000 - 300) poll(cands);
}

function updateLiveDot() {
  $('#nav-live').classList.toggle('has-live', S.fixtures.some(isLive));
  const el = $('#live-status');
  if (el) el.innerHTML = liveStatusText();
}

function liveStatusText() {
  const parts = [];
  if (S.live.lastPoll) parts.push(`Abgefragt vor ${Math.round((Date.now() - S.live.lastPoll) / 1000)} s`);
  if (S.live.interval) parts.push(`alle ${S.live.interval} s`);
  if (liveUrl()) parts.push('Quelle: Live-Server');
  else parts.push(`Quelle: GitHub, Stand ${S.updated ? timeAgo(Date.parse(S.updated)) : '?'} <button class="link" data-open-settings>(Echtzeit einrichten)</button>`);
  if (S.live.error) parts.push(`<span class="err">${esc(S.live.error)}</span>`);
  return parts.join(' · ');
}

// ---------- Views ----------

// Formkurve (letzte 5) aus dem Spielplan berechnen; bei Heim/Auswärts nur diese Spiele.
function formFor(teamId, view) {
  const res = [];
  for (const f of S.fixtures) {
    if (st(f) !== 'FT') continue;
    const home = f.teams.home.id === teamId, away = f.teams.away.id === teamId;
    if (!(home && view !== 'auswaerts') && !(away && view !== 'heim')) continue;
    const gf = home ? f.goals.home : f.goals.away, ga = home ? f.goals.away : f.goals.home;
    res.push(gf > ga ? 'W' : gf === ga ? 'D' : 'L');
  }
  return res.slice(-5).join('');
}

function viewTable() {
  const rowsData = S.tables[S.ui.table]?.length ? S.tables[S.ui.table] : S.standings;
  if (!rowsData.length) return emptyState('Keine Tabelle verfügbar.');
  const fav = favId();
  const form = (s) => [...(s || '')].map((c) => `<i class="f-${c}">${{ W: 'S', D: 'U', L: 'N' }[c] ?? c}</i>`).join('');
  const rows = rowsData.map((r) => `<tr class="${r.team.id === fav ? 'fav' : ''}" data-team="${r.team.id}">
      <td class="rk">${r.rank}</td>
      <td class="tm"><div>${logo(r.team)}<span>${esc(r.team.name)}</span></div></td>
      <td>${r.all.played}</td>
      <td class="hide-s">${r.all.win}</td><td class="hide-s">${r.all.draw}</td><td class="hide-s">${r.all.lose}</td>
      <td class="hide-s">${r.all.goals.for}:${r.all.goals.against}</td>
      <td>${r.goalsDiff > 0 ? '+' : ''}${r.goalsDiff}</td>
      <td class="pts">${r.points}</td>
      <td class="frm hide-xs">${form(r.form || formFor(r.team.id, S.ui.table))}</td>
    </tr>`).join('');
  const tabs = Object.entries(TABLES).map(([k, v]) => `<button class="seg ${k === S.ui.table ? 'on' : ''}" data-table="${k}">${v}</button>`).join('');
  return `<div class="segs">${tabs}</div>
  <section class="card">
    <table class="standings">
      <thead><tr><th>#</th><th class="tm">Team</th><th title="Spiele">Sp</th>
        <th class="hide-s" title="Siege">S</th><th class="hide-s" title="Unentschieden">U</th><th class="hide-s" title="Niederlagen">N</th>
        <th class="hide-s">Tore</th><th title="Tordifferenz">+/-</th><th>Pkt</th><th class="hide-xs">Form</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>
  ${S.updated ? `<p class="muted small center">Quelle: 2liga.at · Stand ${timeAgo(Date.parse(S.updated))}</p>` : ''}`;
}

function rounds() {
  const m = new Map();
  for (const f of S.fixtures) {
    const r = f.league.round;
    if (!m.has(r)) m.set(r, []);
    m.get(r).push(f);
  }
  return [...m.entries()].sort((a, b) => roundNo(a[0]) - roundNo(b[0]));
}

function currentRound(all) {
  const open = all.find(([, fs]) => fs.some((f) => !isFinal(f)));
  return (open || all.at(-1))?.[0] ?? null;
}

function groupByDay(list) {
  let html = '', last = '';
  for (const f of list) {
    const k = f.fixture.timestamp ? dayKey(ko(f)) : 'tbd';
    if (k !== last) { html += `<h3 class="day">${f.fixture.timestamp ? fmtLongDate(ko(f)) : 'Termin offen'}</h3>`; last = k; }
    html += matchRow(f, { showDate: false });
  }
  return html;
}

function viewFixtures() {
  if (!S.fixtures.length) return emptyState('Kein Spielplan verfügbar.');
  const all = rounds();
  const teamOpts = teams().map((t) => `<option value="${t.id}" ${String(t.id) === String(S.ui.team) ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const toolbar = (inner) => `<div class="toolbar">${inner}<select id="team-filter" aria-label="Team filtern"><option value="">Alle Teams</option>${teamOpts}</select></div>`;

  if (S.ui.team) {
    const id = Number(S.ui.team);
    const list = S.fixtures.filter((f) => f.teams.home.id === id || f.teams.away.id === id);
    const next = list.find((f) => !isFinal(f));
    return `${toolbar(`<span class="grow">Saison ${seasonLabel()}</span>`)}
      <section class="card list">${list.map((f) => `<div class="${f === next ? 'is-next' : ''}">${roundTag(f)}${matchRow(f)}</div>`).join('')}</section>`;
  }

  if (!S.ui.round || !all.some(([r]) => r === S.ui.round)) S.ui.round = currentRound(all);
  const idx = all.findIndex(([r]) => r === S.ui.round);
  const [round, list] = all[idx];
  const opts = all.map(([r]) => `<option value="${esc(r)}" ${r === round ? 'selected' : ''}>${esc(roundLabel(r))}</option>`).join('');
  return `${toolbar(`<button class="icon-btn" data-round-step="-1" ${idx <= 0 ? 'disabled' : ''} aria-label="Vorherige Runde">‹</button>
      <select id="round-select" class="grow" aria-label="Runde">${opts}</select>
      <button class="icon-btn" data-round-step="1" ${idx >= all.length - 1 ? 'disabled' : ''} aria-label="Nächste Runde">›</button>`)}
    <section class="card list">${groupByDay(list)}</section>`;
}

const roundTag = (f) => `<div class="round-tag">${esc(roundLabel(f.league.round))}</div>`;

function eventIcon(e) {
  if (e.type === 'Goal') return e.detail === 'Missed Penalty' ? '❌' : e.detail === 'Own Goal' ? '⚽<small>ET</small>' : e.detail === 'Penalty' ? '⚽<small>11m</small>' : '⚽';
  if (e.type === 'Card') return /red/i.test(e.detail) ? '<i class="card-r"></i>' : /second/i.test(e.detail) ? '<i class="card-yr"></i>' : '<i class="card-y"></i>';
  if (e.type === 'subst') return '🔁';
  if (e.type === 'Var') return '📺';
  return '•';
}

function eventText(e) {
  const p = esc(e.player?.name ?? '');
  if (e.type === 'subst') return `<b>${esc(e.assist?.name ?? '')}</b> für ${p}`;
  if (e.type === 'Goal' && e.assist?.name) return `<b>${p}</b> <small>(Vorlage ${esc(e.assist.name)})</small>`;
  if (e.type === 'Other') return `${esc(e.detail)} ${p}`;
  return `<b>${p}</b>`;
}

function timeline(f, events) {
  if (!events?.length) return isFinal(f) || isLive(f) ? '<p class="muted small">Keine Ereignisse.</p>' : '';
  const homeId = f.teams.home.id;
  return `<ol class="timeline">${[...events].reverse().map((e) => {
    const isHome = e.side ? e.side === 'home' : e.team.id === homeId;
    return `<li class="${isHome ? 'h' : 'a'} ev-${esc(e.type).toLowerCase()}">
      <span class="min">${e.time.elapsed}'${e.time.extra ? '+' + e.time.extra : ''}</span>
      <span class="ico">${eventIcon(e)}</span>
      <span class="txt">${eventText(e)}</span>
    </li>`;
  }).join('')}</ol>`;
}

function statsBlock(id) {
  const s = S.stats.get(id);
  if (!s?.length) return '';
  const pct = (v) => Number(String(v).replace(/[^\d.]/g, '')) || 0;
  return `<div class="stats">${s.map((x) => {
    const h = pct(x.home), a = pct(x.away), sum = h + a || 1;
    return `<div class="stat"><span>${esc(x.home)}</span><span class="lbl">${esc(x.type)}</span><span>${esc(x.away)}</span>
      <div class="bar"><i style="width:${(h / sum) * 100}%"></i></div></div>`;
  }).join('')}</div>`;
}

function liveCard(f, { details = false } = {}) {
  const h = f.teams.home, a = f.teams.away;
  const ht = f.score?.halftime;
  return `<article class="card live-card ${isLive(f) ? 'on' : ''}">
    <header class="lc-head">${statusBadge(f) || `<span class="badge">${isFinal(f) ? 'Ende' : f.fixture.timestamp ? 'Anpfiff ' + fmtTime(ko(f)) : 'Termin offen'}</span>`}<span class="muted small">${esc(f.fixture.venue?.name ?? '')}</span></header>
    <div class="lc-score" data-fixture="${f.fixture.id}">
      <div class="lc-team">${logo(h, 'logo lg')}<span>${esc(h.name)}</span></div>
      <div class="lc-goals">${f.goals.home ?? '–'}<span>:</span>${f.goals.away ?? '–'}${ht?.home != null ? `<small>(${ht.home}:${ht.away})</small>` : ''}</div>
      <div class="lc-team">${logo(a, 'logo lg')}<span>${esc(a.name)}</span></div>
    </div>
    ${timeline(f, S.events.get(f.fixture.id))}
    ${details ? statsBlock(f.fixture.id) : ''}
  </article>`;
}

function viewLive() {
  const now = Date.now();
  const cands = liveCandidates(now);
  const todayKey = dayKey(now);
  const today = S.fixtures.filter((f) => f.fixture.timestamp && dayKey(ko(f)) === todayKey && !cands.includes(f));
  const status = `<p id="live-status" class="live-status">${liveStatusText()}</p>`;
  let html = '';
  if (cands.length) {
    html += status + cands.map((f) => liveCard(f)).join('');
  } else {
    const next = S.fixtures.find((f) => f.fixture.timestamp && !isFinal(f) && ko(f) > now);
    html += `<section class="card hero">
      <p class="big">Gerade läuft kein Spiel.</p>
      ${next ? `<p>Nächstes Spiel ${countdown(ko(next))}<br><span class="muted">${fmtLongDate(ko(next))}, ${fmtTime(ko(next))} Uhr</span></p>${matchRow(next)}` : '<p class="muted">Keine weiteren Spiele geplant.</p>'}
      <p class="muted small">Der Ticker startet automatisch ${CONFIG.liveBeforeKickoff / 60e3} Min. vor Anpfiff, solange die App offen ist.
      ${liveUrl() ? 'Aktualisierung über den Live-Server.' : 'Ohne Live-Server nur etwa alle 15 Min. aktuell.'}</p>
    </section>`;
  }
  if (today.length) html += `<h3 class="day">Heute</h3><section class="card list">${today.map((f) => matchRow(f, { showDate: false })).join('')}</section>`;
  return html;
}

// --- News ---

const GENERIC = /\b(FC|SV|SK|SKN|SKU|SC|FK|KSV|ASK|ATSV|USV|WSC|AC|BW|SW|TSV|FAC|SPG|1\.)(?=\s|$)\.?/g;

function aliasTerms(team) {
  const name = team.name;
  const terms = new Set([name]);
  if (/\b(II|Juniors|Amateure)\b/.test(name)) {
    const words = name.replace(/\s+II$/, '').replace(GENERIC, '').trim().split(/\s+/);
    if (/\sII$/.test(name) && words[0]) terms.add(words[0] + ' II');
  } else {
    const core = name.replace(GENERIC, '').replace(/\b(18|19)\d\d\b/, '').replace(/\s+/g, ' ').trim();
    // Reine Städtenamen (z. B. "FAC WIEN" → "WIEN") wären viel zu ungenau
    if (core.length >= 4 && core !== name && /\s/.test(core)) terms.add(core);
  }
  for (const [k, v] of Object.entries(CONFIG.aliases)) if (name.includes(k)) v.forEach((x) => terms.add(x));
  return [...terms].map(norm);
}

const WORDCH = /[\p{L}\p{N}]/u;
function containsWord(text, term) {
  let i = text.indexOf(term);
  while (i !== -1) {
    const b = text[i - 1], a = text[i + term.length];
    if ((!b || !WORDCH.test(b)) && (!a || !WORDCH.test(a))) return true;
    i = text.indexOf(term, i + 1);
  }
  return false;
}

function taggedNews() {
  const matchers = teams().map((t) => ({ team: t, terms: aliasTerms(t) }));
  return (S.news?.items ?? []).map((it) => {
    const text = norm(`${it.title} ${it.summary ?? ''}`);
    return { ...it, teams: matchers.filter((m) => m.terms.some((t) => containsWord(text, t))).map((m) => m.team) };
  });
}

function viewNews() {
  if (!S.news) return emptyState('News werden geladen …');
  const all = taggedNews();
  const sel = new Set(S.ui.newsTeams.map(Number));
  const list = sel.size ? all.filter((n) => n.teams.some((t) => sel.has(t.id))) : all;
  const fav = favId();
  const chips = teams().map((t) => `<button class="chip ${sel.has(t.id) ? 'on' : ''}" data-news-team="${t.id}">${logo(t, 'logo xs')}${esc(t.name)}${t.id === fav ? ' ★' : ''}</button>`).join('');
  const items = list.map((n) => `<a class="news ${n.image ? 'has-img' : ''}" href="${esc(n.link)}" target="_blank" rel="noopener">
      ${n.image ? `<img class="thumb" src="${esc(n.image)}" alt="" loading="lazy">` : ''}
      <span class="body">
        <span class="src">${esc(n.source ?? '')}${n.date ? ' · ' + timeAgo(Date.parse(n.date)) : ''}</span>
        <span class="ttl">${esc(n.title)}</span>
        ${n.summary ? `<span class="sum">${esc(n.summary)}</span>` : ''}
        ${n.teams.length ? `<span class="tags">${n.teams.map((t) => `<i>${esc(t.name)}</i>`).join('')}</span>` : ''}
      </span>
    </a>`).join('');
  return `<div class="chips">
      <button class="chip ${sel.size ? '' : 'on'}" data-news-team="">Alle</button>
      ${fav ? `<button class="chip" data-news-team="fav">★ Mein Team</button>` : ''}
      ${chips}
    </div>
    <section class="card list">${items || '<p class="muted pad">Keine News für diese Auswahl.</p>'}</section>
    <p class="muted small center">${S.news.updated ? `Stand ${timeAgo(Date.parse(S.news.updated))}` : 'Noch keine News geladen – die GitHub Action aktualisiert alle 15 Min.'}</p>`;
}

function emptyState(msg) {
  return `<section class="card pad center">${S.loading ? '<div class="spinner"></div>' : `<p>${esc(msg)}</p>`}</section>`;
}

// ---------- Detail-Dialog ----------

async function openFixture(id) {
  const f = S.byId.get(id);
  if (!f) return;
  const dlg = $('#match-dialog');
  const body = $('#match-body');
  const draw = () => {
    const cur = S.byId.get(id);
    body.innerHTML = `${liveCard(cur, { details: true })}
      <p class="muted small center">${esc(roundLabel(cur.league.round))}${cur.fixture.timestamp ? ` · ${fmtLongDate(ko(cur))}, ${fmtTime(ko(cur))} Uhr` : ''}${cur.fixture.referee ? ' · SR ' + esc(cur.fixture.referee) : ''}${cur.fixture.attendance ? ' · ' + cur.fixture.attendance.toLocaleString('de-AT') + ' Zuschauer' : ''}</p>
      ${cur.fixture.season ? `<p class="center small"><a href="${esc(reportUrl(cur))}" target="_blank" rel="noopener">Spielbericht auf 2liga.at ↗</a></p>` : ''}`;
  };
  draw();
  dlg.showModal();
  const started = !['NS', 'TBD', 'PST', 'CANC'].includes(st(f));
  if (started && !S.events.has(id) && liveUrl() && f.fixture.season) {
    try {
      const r = await getJson(`${liveUrl()}/match?season=${encodeURIComponent(f.fixture.season)}&ids=${id}`);
      if (r.list?.[0]) { mergeFixture(r.list[0]); if (dlg.open) draw(); }
    } catch (e) { toast(e.message); }
  }
}

// ---------- Einstellungen ----------

function openSettings() {
  const dlg = $('#settings-dialog');
  const fav = favId();
  const teamOpts = teams().map((t) => `<option value="${t.id}" ${t.id === fav ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  $('#settings-body').innerHTML = `
    <label>Mein Team
      <select id="set-fav"><option value="">– keins –</option>${teamOpts}</select>
    </label>
    <label>Live-Aktualisierung (Sekunden)
      <input type="number" id="set-interval" min="${CONFIG.minInterval}" max="600" step="5" value="${store.get('interval', CONFIG.defaultInterval)}">
      <small class="muted">${liveUrl() ? 'Live-Server aktiv.' : `Ohne Live-Server mindestens ${CONFIG.fallbackInterval} s – neue Daten gibt es dann nur ca. alle 15 Min.`}</small>
    </label>
    <label class="row"><input type="checkbox" id="set-notify" ${store.get('notify', false) ? 'checked' : ''}> Benachrichtigung bei Toren</label>
    <label class="row"><input type="checkbox" id="set-notify-fav" ${store.get('notifyFavOnly', false) ? 'checked' : ''}> … nur für mein Team</label>
    <details ${!liveUrl() ? 'open' : ''}><summary>Live-Server (Echtzeit-Ticker)</summary>
      <p class="small muted">${S.config.liveUrl ? `Automatisch eingerichtet: ${esc(S.config.liveUrl)}` : 'Noch keiner eingerichtet. Anleitung: README im Repository (Cloudflare Worker, gratis).'}</p>
      <label>Eigene URL (leer = automatisch)<input type="url" id="set-live" value="${esc(store.get('liveUrl', ''))}" placeholder="https://ligazwa-live.xxx.workers.dev"></label>
    </details>`;
  dlg.showModal();
}

async function saveSettings() {
  const prevLive = liveUrl();
  store.set('favorite', Number($('#set-fav').value) || null);
  store.set('interval', Math.max(CONFIG.minInterval, Number($('#set-interval').value) || CONFIG.defaultInterval));
  store.set('notifyFavOnly', $('#set-notify-fav').checked);
  store.set('liveUrl', $('#set-live').value.trim());

  const wantNotify = $('#set-notify').checked;
  if (wantNotify && 'Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  store.set('notify', wantNotify && 'Notification' in window && Notification.permission === 'granted');
  if (wantNotify && !store.get('notify')) toast('Benachrichtigungen vom Browser blockiert.');
  if (liveUrl() !== prevLive) S.live.lastPoll = 0;
  render();
  tick();
}

// ---------- Rendering & Routing ----------

function route() {
  const r = location.hash.slice(1);
  return ROUTES.includes(r) ? r : 'tabelle';
}

function render() {
  const r = route();
  $$('nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + r));
  $('#league-name').textContent = `ADMIRAL 2. Liga ${seasonLabel()}`;
  const err = S.error ? `<div class="banner err">${esc(S.error)} <button class="link" data-reload>Neu laden</button></div>` : '';
  const view = { tabelle: viewTable, spielplan: viewFixtures, live: viewLive, news: viewNews }[r];
  const scrollY = window.scrollY;
  $('#view').innerHTML = err + view();
  window.scrollTo(0, scrollY);
}

function bindEvents() {
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); render(); } });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-fixture],[data-round-step],[data-news-team],[data-open-settings],[data-reload],[data-close],[data-table]');
    if (!t) return;
    if (t.dataset.fixture) openFixture(Number(t.dataset.fixture));
    else if (t.dataset.table) { S.ui.table = t.dataset.table; store.set('tableView', S.ui.table); render(); }
    else if (t.dataset.roundStep) {
      const all = rounds();
      const i = all.findIndex(([r]) => r === S.ui.round) + Number(t.dataset.roundStep);
      if (all[i]) { S.ui.round = all[i][0]; render(); }
    } else if ('newsTeam' in t.dataset) {
      const v = t.dataset.newsTeam;
      if (v === '') S.ui.newsTeams = [];
      else if (v === 'fav') S.ui.newsTeams = favId() ? [favId()] : [];
      else {
        const id = Number(v);
        S.ui.newsTeams = S.ui.newsTeams.includes(id) ? S.ui.newsTeams.filter((x) => x !== id) : [...S.ui.newsTeams, id];
      }
      store.set('newsTeams', S.ui.newsTeams);
      render();
    } else if ('openSettings' in t.dataset) openSettings();
    else if ('reload' in t.dataset) loadAll();
    else if ('close' in t.dataset) t.closest('dialog').close();
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'round-select') { S.ui.round = e.target.value; render(); }
    if (e.target.id === 'team-filter') { S.ui.team = e.target.value; store.set('fixtureTeam', S.ui.team); render(); }
  });

  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-form').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'save') saveSettings();
  });
  $('#refresh-btn').addEventListener('click', () => { loadAll(); loadNews(); });
}

function init() {
  bindEvents();
  render();
  loadAll();
  loadNews();
  setInterval(tick, 1000);
  setInterval(loadNews, 10 * 60e3);
  // Ohne Live-Spiel Tabelle & Spielplan gelegentlich neu laden (GitHub-Daten ändern sich alle 15 Min.)
  setInterval(() => { if (!liveCandidates().length && !document.hidden) loadAll(); }, 15 * 60e3);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
