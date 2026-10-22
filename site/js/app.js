import { CONFIG } from './config.js';
import { $, $$, esc, store, fmtDay, fmtTime, fmtLongDate, dayKey, timeAgo, countdown, norm } from './util.js';
import { apiProvider, getQuota } from './api.js';
import { demoProvider, demoNews } from './demo.js';

const FINAL = new Set(['FT', 'AET', 'PEN', 'PST', 'CANC', 'ABD', 'AWD', 'WO']);
const IN_PLAY = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']);
const ROUTES = ['tabelle', 'spielplan', 'live', 'news'];

const S = {
  provider: null,
  league: null,
  standings: [],
  fixtures: [],
  byId: new Map(),
  events: new Map(),
  news: null,
  error: null,
  loading: true,
  live: { lastPoll: 0, polling: false, error: null, interval: null, seen: new Set() },
  ui: {
    round: null,
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
  if (IN_PLAY.has(s)) return `<span class="badge live">${e ?? ''}${e ? "'" : 'Live'}${f.fixture.status.extra ? '+' + f.fixture.status.extra : ''}</span>`;
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
    <span class="meta">${showDate ? fmtDay(ko(f)) : ''}${statusBadge(f)}</span>
    <span class="${cls(h)} home"><span class="name">${esc(h.name)}</span>${logo(h)}</span>
    ${scoreCell(f)}
    <span class="${cls(a)} away">${logo(a)}<span class="name">${esc(a.name)}</span></span>
  </button>`;
}

function setFixtures(list) {
  S.fixtures = [...list].sort((x, y) => ko(x) - ko(y));
  S.byId = new Map(S.fixtures.map((f) => [f.fixture.id, f]));
}

function mergeFixture(f) {
  const { events, ...rest } = f;
  if (events) S.events.set(f.fixture.id, events);
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

function pickProvider() {
  const key = store.get('apiKey', '');
  S.provider = !key || store.get('demo', false) ? demoProvider : apiProvider;
}

// /status kostet kein Kontingent und liefert den echten Stand, auch wenn der Browser
// die Rate-Limit-Header (CORS) nicht lesen darf.
let lastStatus = 0;
function syncQuota() {
  if (S.provider === demoProvider || Date.now() - lastStatus < 10 * 60e3) return;
  lastStatus = Date.now();
  S.provider.getStatus().catch(() => {});
}

async function loadAll(force = false, forceLeague = false) {
  syncQuota();
  S.loading = true;
  S.error = null;
  render();
  try {
    S.league = await S.provider.getLeague(forceLeague);
    const [stR, fxR] = await Promise.allSettled([
      S.provider.getStandings(S.league, force),
      S.provider.getFixtures(S.league, force),
    ]);
    if (stR.status === 'fulfilled') S.standings = stR.value.rows; else S.error = stR.reason.message;
    if (fxR.status === 'fulfilled') setFixtures(fxR.value.list); else S.error = fxR.reason.message;
    const stale = stR.value?.__stale || fxR.value?.__stale;
    if (stale && !S.error) S.error = `Zeige zwischengespeicherte Daten (${stale})`;
  } catch (e) {
    S.error = e.message;
  }
  S.loading = false;
  render();
  tick();
}

async function refreshStandings() {
  try {
    const r = await S.provider.getStandings(S.league, true);
    S.standings = r.rows;
    render();
  } catch { /* nächster Versuch beim nächsten Spielende */ }
}

async function loadNews() {
  try {
    const res = await fetch(CONFIG.newsUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error();
    S.news = await res.json();
  } catch {
    S.news = { updated: null, items: [] };
  }
  if (!S.news.items?.length && S.provider === demoProvider) S.news = demoNews();
  if (route() === 'news') render();
}

// ---------- Live-Ticker ----------

function liveCandidates(now = Date.now()) {
  return S.fixtures.filter((f) => !isFinal(f)
    && now >= ko(f) - CONFIG.liveBeforeKickoff
    && now <= ko(f) + CONFIG.liveMaxWindow);
}

// Wie viele Millisekunden Live-Zeit liegen heute noch vor uns (Vereinigung aller Spielfenster)?
function remainingLiveMs(now) {
  const horizon = now + 18 * 3600e3;
  const wins = S.fixtures.filter((f) => !isFinal(f))
    .map((f) => [Math.max(now, ko(f) - CONFIG.liveBeforeKickoff), ko(f) + CONFIG.matchDuration])
    .filter(([a, b]) => b > a && a < horizon)
    .sort((x, y) => x[0] - y[0]);
  let total = 0, end = -Infinity;
  for (const [a, b] of wins) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

// Passt das Intervall so an, dass das Tageskontingent bis zum letzten Spiel reicht.
function computeInterval() {
  const user = Math.max(CONFIG.minInterval, Number(store.get('interval', CONFIG.defaultInterval)) || CONFIG.defaultInterval);
  if (S.provider === demoProvider) return { sec: user, throttled: false };
  const q = getQuota();
  if (q.remaining === null || q.remaining === undefined) return { sec: user, throttled: false };
  const avail = q.remaining - CONFIG.quotaReserve;
  if (avail <= 0) return { sec: null, throttled: true };
  const secs = remainingLiveMs(Date.now()) / 1000;
  if (secs / user <= avail) return { sec: user, throttled: false };
  return { sec: Math.ceil(secs / avail), throttled: true };
}

function notifyGoal(prev, next) {
  const before = (prev?.goals.home ?? 0) + (prev?.goals.away ?? 0);
  const after = (next.goals.home ?? 0) + (next.goals.away ?? 0);
  if (!S.live.seen.has(next.fixture.id) || after <= before) return;
  const goal = (next.events || []).filter((e) => e.type === 'Goal' && e.detail !== 'Missed Penalty').at(-1);
  const title = `⚽ ${next.teams.home.name} ${next.goals.home}:${next.goals.away} ${next.teams.away.name}`;
  const body = goal ? `${goal.time.elapsed}' ${goal.player?.name ?? ''} (${goal.team.name})` : '';
  toast(`${title} ${body}`);
  const fav = favId();
  const onlyFav = store.get('notifyFavOnly', false);
  if (onlyFav && fav && next.teams.home.id !== fav && next.teams.away.id !== fav) return;
  if (store.get('notify', false) && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: 'icon.svg', tag: 'goal-' + next.fixture.id }); } catch { /* iOS ohne PWA */ }
  }
}

async function poll(cands) {
  S.live.polling = true;
  try {
    const upd = await S.provider.getFixturesByIds(cands.map((f) => f.fixture.id));
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
  if (S.loading || S.live.polling || !S.league) return;
  if (document.hidden && !store.get('notify', false)) return;
  const cands = liveCandidates();
  updateLiveDot();
  if (!cands.length) { S.live.interval = null; return; }
  syncQuota();
  S.live.interval = computeInterval();
  if (S.live.interval.sec === null) return;
  if (Date.now() - S.live.lastPoll >= S.live.interval.sec * 1000 - 300) poll(cands);
}

function updateLiveDot() {
  $('#nav-live').classList.toggle('has-live', S.fixtures.some(isLive));
  const el = $('#live-status');
  if (el) el.innerHTML = liveStatusText();
}

function liveStatusText() {
  const iv = S.live.interval;
  const q = getQuota();
  const parts = [];
  if (S.live.lastPoll) parts.push(`Aktualisiert ${Math.round((Date.now() - S.live.lastPoll) / 1000)} s`);
  if (iv?.sec) parts.push(`alle ${iv.sec} s${iv.throttled ? ' (gedrosselt wegen Kontingent)' : ''}`);
  if (iv && iv.sec === null) parts.push('<b>Tageskontingent aufgebraucht</b>');
  if (S.provider !== demoProvider && q.remaining !== null) parts.push(`Kontingent ${q.remaining}${q.limit ? '/' + q.limit : ''}`);
  if (S.live.error) parts.push(`<span class="err">${esc(S.live.error)}</span>`);
  return parts.join(' · ');
}

// ---------- Views ----------

function zoneClass(desc) {
  if (!desc) return '';
  if (/promotion|aufstieg/i.test(desc)) return /play|relegation/i.test(desc) ? 'z-up2' : 'z-up';
  if (/relegation|abstieg/i.test(desc)) return 'z-down';
  return '';
}

function viewTable() {
  if (!S.standings.length) return emptyState('Keine Tabelle verfügbar.');
  const fav = favId();
  const form = (s) => [...(s || '')].map((c) => `<i class="f-${c}">${{ W: 'S', D: 'U', L: 'N' }[c] ?? c}</i>`).join('');
  const rows = S.standings.map((r) => `<tr class="${zoneClass(r.description)} ${r.team.id === fav ? 'fav' : ''}" data-team="${r.team.id}">
      <td class="rk">${r.rank}</td>
      <td class="tm"><div>${logo(r.team)}<span>${esc(r.team.name)}</span></div></td>
      <td>${r.all.played}</td>
      <td class="hide-s">${r.all.win}</td><td class="hide-s">${r.all.draw}</td><td class="hide-s">${r.all.lose}</td>
      <td class="hide-s">${r.all.goals.for}:${r.all.goals.against}</td>
      <td>${r.goalsDiff > 0 ? '+' : ''}${r.goalsDiff}</td>
      <td class="pts">${r.points}</td>
      <td class="frm hide-xs">${form(r.form)}</td>
    </tr>`).join('');
  const legend = [...new Set(S.standings.map((r) => r.description).filter(Boolean))]
    .map((d) => `<span class="lg ${zoneClass(d)}">${esc(d)}</span>`).join('');
  return `<section class="card">
    <table class="standings">
      <thead><tr><th>#</th><th class="tm">Team</th><th title="Spiele">Sp</th>
        <th class="hide-s" title="Siege">S</th><th class="hide-s" title="Unentschieden">U</th><th class="hide-s" title="Niederlagen">N</th>
        <th class="hide-s">Tore</th><th title="Tordifferenz">+/-</th><th>Pkt</th><th class="hide-xs">Form</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${legend ? `<div class="legend">${legend}</div>` : ''}
  </section>`;
}

function rounds() {
  const m = new Map();
  for (const f of S.fixtures) {
    const r = f.league.round;
    if (!m.has(r)) m.set(r, []);
    m.get(r).push(f);
  }
  return [...m.entries()].sort((a, b) => roundNo(a[0]) - roundNo(b[0]) || ko(a[1][0]) - ko(b[1][0]));
}

function currentRound(all) {
  const open = all.find(([, fs]) => fs.some((f) => !isFinal(f)));
  return (open || all.at(-1))?.[0] ?? null;
}

function groupByDay(list) {
  let html = '', last = '';
  for (const f of list) {
    const k = dayKey(ko(f));
    if (k !== last) { html += `<h3 class="day">${fmtLongDate(ko(f))}</h3>`; last = k; }
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
    return `${toolbar('<span class="grow">Saison ' + S.league.season + '/' + String(S.league.season + 1).slice(-2) + '</span>')}
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
  if (e.type === 'Card') return /red/i.test(e.detail) ? '<i class="card-r"></i>' : /yellow/i.test(e.detail) && /second/i.test(e.detail) ? '<i class="card-yr"></i>' : '<i class="card-y"></i>';
  if (e.type === 'subst') return '🔁';
  if (e.type === 'Var') return '📺';
  return '•';
}

function eventText(e) {
  const p = esc(e.player?.name ?? '');
  if (e.type === 'subst') return `<b>${esc(e.assist?.name ?? '')}</b> für ${p}`;
  if (e.type === 'Goal' && e.assist?.name) return `<b>${p}</b> <small>(Vorlage ${esc(e.assist.name)})</small>`;
  if (e.type === 'Var') return `VAR: ${esc(e.detail)} ${p}`;
  return `<b>${p}</b>`;
}

function timeline(f, events) {
  if (!events?.length) return '<p class="muted small">Noch keine Ereignisse.</p>';
  const homeId = f.teams.home.id;
  return `<ol class="timeline">${[...events].reverse().map((e) => `<li class="${e.team.id === homeId ? 'h' : 'a'} ev-${esc(e.type).toLowerCase()}">
      <span class="min">${e.time.elapsed}'${e.time.extra ? '+' + e.time.extra : ''}</span>
      <span class="ico">${eventIcon(e)}</span>
      <span class="txt">${eventText(e)}</span>
    </li>`).join('')}</ol>`;
}

function liveCard(f) {
  const h = f.teams.home, a = f.teams.away;
  return `<article class="card live-card ${isLive(f) ? 'on' : ''}">
    <header class="lc-head">${statusBadge(f) || `<span class="badge">${isFinal(f) ? 'Ende' : 'Anpfiff ' + fmtTime(ko(f))}</span>`}<span class="muted small">${esc(f.fixture.venue?.name ?? '')}</span></header>
    <div class="lc-score" data-fixture="${f.fixture.id}">
      <div class="lc-team">${logo(h, 'logo lg')}<span>${esc(h.name)}</span></div>
      <div class="lc-goals">${f.goals.home ?? '–'}<span>:</span>${f.goals.away ?? '–'}</div>
      <div class="lc-team">${logo(a, 'logo lg')}<span>${esc(a.name)}</span></div>
    </div>
    ${timeline(f, S.events.get(f.fixture.id))}
  </article>`;
}

function viewLive() {
  const now = Date.now();
  const cands = liveCandidates(now);
  const todayKey = dayKey(now);
  const today = S.fixtures.filter((f) => dayKey(ko(f)) === todayKey && !cands.includes(f));
  const status = `<p id="live-status" class="live-status">${liveStatusText()}</p>`;
  let html = '';
  if (cands.length) {
    html += status + cands.map(liveCard).join('');
  } else {
    const next = S.fixtures.find((f) => !isFinal(f) && ko(f) > now);
    html += `<section class="card hero">
      <p class="big">Gerade läuft kein Spiel.</p>
      ${next ? `<p>Nächstes Spiel ${countdown(ko(next))}<br><span class="muted">${fmtLongDate(ko(next))}, ${fmtTime(ko(next))} Uhr</span></p>${matchRow(next)}` : '<p class="muted">Keine weiteren Spiele geplant.</p>'}
      <p class="muted small">Der Ticker startet automatisch ${CONFIG.liveBeforeKickoff / 60e3} Min. vor Anpfiff, solange die App offen ist.</p>
    </section>`;
  }
  if (today.length) html += `<h3 class="day">Heute</h3><section class="card list">${today.map((f) => matchRow(f, { showDate: false })).join('')}</section>`;
  return html;
}

// --- News ---

const GENERIC = /\b(FC|SV|SK|SKN|SKU|SC|FK|KSV|ASK|ATSV|USV|WSC|AC|BW|SW|TSV|FAC|SPG|1\.)(?=\s|$)\.?/g;

function aliasTerms(name) {
  const terms = new Set([name]);
  if (/\b(II|Juniors|Amateure)\b/.test(name)) {
    const words = name.replace(/\s+II$/, '').replace(GENERIC, '').trim().split(/\s+/);
    if (/\sII$/.test(name) && words[0]) terms.add(words[0] + ' II');
  } else {
    const core = name.replace(GENERIC, '').replace(/\s+/g, ' ').trim();
    if (core.length >= 4 && core !== name) terms.add(core);
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
  const matchers = teams().map((t) => ({ team: t, terms: aliasTerms(t.name) }));
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
  const items = list.map((n) => `<a class="news" href="${esc(n.link)}" target="_blank" rel="noopener">
      <span class="src">${esc(n.source ?? '')} · ${n.date ? timeAgo(Date.parse(n.date)) : ''}</span>
      <span class="ttl">${esc(n.title)}</span>
      ${n.summary ? `<span class="sum">${esc(n.summary)}</span>` : ''}
      ${n.teams.length ? `<span class="tags">${n.teams.map((t) => `<i>${esc(t.name)}</i>`).join('')}</span>` : ''}
    </a>`).join('');
  return `<div class="chips">
      <button class="chip ${sel.size ? '' : 'on'}" data-news-team="">Alle</button>
      ${fav ? `<button class="chip" data-news-team="fav">★ Mein Team</button>` : ''}
      ${chips}
    </div>
    <section class="card list">${items || '<p class="muted pad">Keine News für diese Auswahl.</p>'}</section>
    <p class="muted small center">${S.news.updated ? `Stand ${timeAgo(Date.parse(S.news.updated))}` : 'Noch keine News geladen – die GitHub Action aktualisiert alle 30 Min.'}</p>`;
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
    body.innerHTML = `${liveCard(cur)}
      <p class="muted small center">${esc(roundLabel(cur.league.round))} · ${fmtLongDate(ko(cur))}, ${fmtTime(ko(cur))} Uhr${cur.fixture.referee ? ' · SR ' + esc(cur.fixture.referee) : ''}</p>`;
  };
  draw();
  dlg.showModal();
  const started = !['NS', 'TBD', 'PST', 'CANC'].includes(st(f));
  if (started && !S.events.has(id)) {
    const ck = 'cache:ev:' + id;
    const cached = store.get(ck, null);
    if (cached) { S.events.set(id, cached); draw(); return; }
    try {
      const [full] = await S.provider.getFixturesByIds([id]);
      if (full) {
        mergeFixture(full);
        if (FINAL.has(full.fixture.status.short)) store.set(ck, full.events ?? []);
        if (dlg.open) draw();
      }
    } catch (e) { toast(e.message); }
  }
}

// ---------- Einstellungen ----------

function openSettings() {
  const dlg = $('#settings-dialog');
  const q = getQuota();
  const fav = favId();
  const teamOpts = teams().map((t) => `<option value="${t.id}" ${t.id === fav ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  $('#settings-body').innerHTML = `
    <label>API-Football Key
      <input type="password" id="set-key" value="${esc(store.get('apiKey', ''))}" autocomplete="off" spellcheck="false" placeholder="Key von dashboard.api-football.com">
      <small class="muted">Wird nur in diesem Browser gespeichert, nie im Repository.</small>
    </label>
    <label class="row"><input type="checkbox" id="set-demo" ${store.get('demo', false) ? 'checked' : ''}> Demo-Modus (erfundene Daten)</label>
    <label>Mein Team
      <select id="set-fav"><option value="">– keins –</option>${teamOpts}</select>
    </label>
    <label>Live-Aktualisierung (Sekunden)
      <input type="number" id="set-interval" min="${CONFIG.minInterval}" max="600" step="5" value="${store.get('interval', CONFIG.defaultInterval)}">
      <small class="muted">Wird automatisch verlängert, falls das Tageskontingent sonst nicht reicht.</small>
    </label>
    <label class="row"><input type="checkbox" id="set-notify" ${store.get('notify', false) ? 'checked' : ''}> Benachrichtigung bei Toren</label>
    <label class="row"><input type="checkbox" id="set-notify-fav" ${store.get('notifyFavOnly', false) ? 'checked' : ''}> … nur für mein Team</label>
    <div class="quota" id="quota-box">Kontingent heute: ${q.remaining ?? '?'}${q.limit ? ' / ' + q.limit : ''} Anfragen übrig</div>
    <details><summary>Erweitert</summary>
      <label>Liga-ID (leer = automatisch)<input type="number" id="set-league" value="${store.get('leagueId', '') ?? ''}"></label>
      <label>Saison (Startjahr, leer = automatisch)<input type="number" id="set-season" value="${store.get('season', '') ?? ''}"></label>
      <div class="btn-row">
        <button type="button" id="btn-status">Kontingent prüfen</button>
        <button type="button" id="btn-clear">Cache leeren</button>
      </div>
    </details>`;
  dlg.showModal();

  $('#btn-status').onclick = async () => {
    try {
      const s = await S.provider.getStatus();
      $('#quota-box').textContent = `Plan: ${s.plan ?? '?'} · heute ${s.remaining ?? '?'}${s.limit ? ' / ' + s.limit : ''} Anfragen übrig`;
    } catch (e) { $('#quota-box').textContent = e.message; }
  };
  $('#btn-clear').onclick = () => { store.clearCache(); toast('Cache geleert'); };
}

async function saveSettings() {
  const prevKey = store.get('apiKey', '');
  const prevDemo = store.get('demo', false);
  const prevLeague = [store.get('leagueId', null), store.get('season', null)].join();
  const key = $('#set-key').value.trim();
  store.set('apiKey', key);
  store.set('demo', $('#set-demo').checked);
  store.set('favorite', Number($('#set-fav').value) || null);
  store.set('interval', Math.max(CONFIG.minInterval, Number($('#set-interval').value) || CONFIG.defaultInterval));
  store.set('notifyFavOnly', $('#set-notify-fav').checked);
  const lid = Number($('#set-league').value) || null;
  const sea = Number($('#set-season').value) || null;
  store.set('leagueId', lid);
  store.set('season', sea);

  const wantNotify = $('#set-notify').checked;
  if (wantNotify && 'Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  store.set('notify', wantNotify && 'Notification' in window && Notification.permission === 'granted');
  if (wantNotify && !store.get('notify')) toast('Benachrichtigungen vom Browser blockiert.');

  if (key !== prevKey || $('#set-demo').checked !== prevDemo || [lid, sea].join() !== prevLeague) {
    if (key !== prevKey) store.clearCache();
    pickProvider();
    lastStatus = 0;
    S.events.clear();
    S.live = { lastPoll: 0, polling: false, error: null, interval: null, seen: new Set() };
    S.ui.round = null;
    loadAll(true, true);
    loadNews();
  } else {
    render();
  }
}

// ---------- Rendering & Routing ----------

function route() {
  const r = location.hash.slice(1);
  return ROUTES.includes(r) ? r : 'tabelle';
}

function render() {
  const r = route();
  $$('nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + r));
  const title = S.league ? `${S.league.name} ${S.league.season}/${String(S.league.season + 1).slice(-2)}` : '2. Liga';
  $('#league-name').textContent = title;
  const banner = S.provider === demoProvider
    ? `<div class="banner">Demo-Modus mit erfundenen Daten. <button class="link" data-open-settings>API-Key eintragen</button></div>` : '';
  const err = S.error ? `<div class="banner err">${esc(S.error)} <button class="link" data-reload>Neu laden</button></div>` : '';
  const view = { tabelle: viewTable, spielplan: viewFixtures, live: viewLive, news: viewNews }[r];
  const scrollY = window.scrollY;
  $('#view').innerHTML = banner + err + view();
  window.scrollTo(0, scrollY);
}

function bindEvents() {
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); render(); } });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-fixture],[data-round-step],[data-news-team],[data-open-settings],[data-reload],[data-close]');
    if (!t) return;
    if (t.dataset.fixture) openFixture(Number(t.dataset.fixture));
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
    else if ('reload' in t.dataset) loadAll(true);
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
  $('#refresh-btn').addEventListener('click', () => { loadAll(true); loadNews(); });
}

function init() {
  pickProvider();
  bindEvents();
  render();
  loadAll();
  loadNews();
  setInterval(tick, 1000);
  setInterval(loadNews, 10 * 60e3);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
