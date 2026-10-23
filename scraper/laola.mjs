// Live-Daten aus dem laola1-Matchcenter (Sportradar), umgeformt ins Format der App.
// Wird vom Cloudflare Worker genutzt; laola1 erlaubt keine Browser-Anfragen von fremden Seiten (CORS).

export const LAOLA = 'https://matchcenter.laola1.at/data/Fussball/Oesterreich/2Liga';

async function getJson(path, fetchImpl) {
  const res = await fetchImpl(LAOLA + path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`laola1 ${path}: HTTP ${res.status}`);
  return res.json();
}

// "Brandt, Marco" → "Marco Brandt"
const name = (p) => (p?.name || '').split(', ').reverse().join(' ').trim() || null;

function status(info) {
  const s = info?.status_info || {};
  const all = `${info?.status} ${s.status} ${s.live_status}`.toLowerCase();
  if (/postponed/.test(all)) return { short: 'PST', long: 'Verschoben' };
  if (/cancel/.test(all)) return { short: 'CANC', long: 'Abgesagt' };
  if (/abandon|interrupt/.test(all)) return { short: 'ABD', long: 'Abgebrochen' };
  if (/closed|ended/.test(all)) return { short: 'FT', long: 'Beendet' };
  if (/halftime|pause|break/.test(all)) return { short: 'HT', long: 'Halbzeit' };
  if (/not_started/.test(all)) return { short: 'NS', long: 'Nicht begonnen' };
  return { short: 'LIVE', long: s.live_status || 'Live' };
}

const CARD = { yellow_card: 'Yellow Card', red_card: 'Red Card', yellow_red_card: 'Second Yellow card' };

function events(timeline) {
  const out = [];
  for (const e of timeline) {
    const time = { elapsed: e.match_time ?? 0, extra: e.stoppage_time || null };
    const side = e.competitor || null;
    const players = e.players || [];
    if (e.type === 'score_change') {
      const scorer = players.find((p) => p.type === 'scorer') || players[0];
      const assist = players.find((p) => p.type === 'assist');
      const detail = e.method === 'penalty' ? 'Penalty' : e.method === 'own_goal' ? 'Own Goal' : 'Normal Goal';
      out.push({ time, side, type: 'Goal', detail, player: { name: name(scorer) }, assist: { name: name(assist) } });
    } else if (CARD[e.type]) {
      out.push({ time, side, type: 'Card', detail: CARD[e.type], player: { name: name(players[0]) }, assist: { name: null } });
    } else if (e.type === 'substitution') {
      const outP = players.find((p) => p.type === 'substituted_out');
      const inP = players.find((p) => p.type === 'substituted_in');
      out.push({ time, side, type: 'subst', detail: 'Substitution', player: { name: name(outP) }, assist: { name: name(inP) } });
    } else if (e.type === 'penalty_missed') {
      out.push({ time, side, type: 'Goal', detail: 'Missed Penalty', player: { name: name(players[0]) }, assist: { name: null } });
    } else if (e.type === 'video_assistant_referee' || e.type === 'video_assistant_referee_over') {
      out.push({ time, side, type: 'Var', detail: e.title || 'VAR', player: { name: null }, assist: { name: null } });
    }
  }
  // Doppelte Meldungen (gleiche ID kommen bei laola1 vor) entfernen
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.type}|${e.time.elapsed}|${e.time.extra}|${e.player.name}|${e.assist.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.time.elapsed - b.time.elapsed || (a.time.extra ?? 0) - (b.time.extra ?? 0));
}

// Ticker-Texte (neueste zuerst)
function commentary(timeline) {
  const seen = new Set();
  return timeline.filter((e) => (e.text || e.title) && !seen.has(e.id) && seen.add(e.id))
    .map((e) => ({
      minute: e.match_time ?? null, extra: e.stoppage_time || null, type: e.type,
      title: e.title || null, text: (e.text || '').trim() || null, side: e.competitor || null,
    }));
}

function statistics(stats) {
  const t = stats?.statistics?.team_statistics;
  if (!t?.length) return [];
  const home = t.find((x) => x.team === 'home') || t[0];
  const away = t.find((x) => x.team === 'away') || t[1];
  const rows = [
    ['Ballbesitz', (s) => s.ball_info?.ball_possessions, '%'],
    ['Schüsse aufs Tor', (s) => s.goal_info?.shots_on_target],
    ['Schüsse daneben', (s) => s.goal_info?.shots_off_target],
    ['Geblockte Schüsse', (s) => s.goal_info?.shots_blocked],
    ['Eckbälle', (s) => s.ball_info?.corner_kicks],
    ['Abseits', (s) => s.ball_info?.offsides],
    ['Fouls', (s) => s.penalty?.fouls],
    ['Gelbe Karten', (s) => s.penalty?.yellow_cards],
    ['Rote Karten', (s) => s.penalty?.red_cards],
  ];
  return rows.map(([type, f, unit = '']) => {
    const h = f(home), a = f(away);
    return h == null && a == null ? null : { type, home: `${h ?? 0}${unit}`, away: `${a ?? 0}${unit}` };
  }).filter(Boolean);
}

function team(c) {
  return { name: c?.name ?? null, abbr: c?.abbreviation ?? null };
}

export function toFixture(info, timeline = [], stats = null) {
  const st = status(info);
  const r = info.result || {};
  const ps = r.period_scores || [];
  const home = info.competitors?.find((c) => c.qualifier === 'home');
  const away = info.competitors?.find((c) => c.qualifier === 'away');
  const mt = String(info.status_info?.match_time ?? '').match(/^(\d+)/);
  const lastMinute = timeline.reduce((m, e) => Math.max(m, e.match_time ?? 0), 0);
  return {
    laolaId: info.id,
    scheduled: info.scheduled,
    teams: { home: team(home), away: team(away) },
    fixture: {
      status: { ...st, elapsed: ['LIVE', 'HT'].includes(st.short) ? (mt ? Number(mt[1]) : lastMinute || null) : null, extra: null },
      venue: { name: info.venue?.name ?? null },
    },
    goals: { home: r.home_score ?? null, away: r.away_score ?? null },
    score: { halftime: { home: ps[0]?.home_score ?? null, away: ps[0]?.away_score ?? null } },
    events: events(timeline),
    commentary: commentary(timeline),
    statistics: statistics(stats),
  };
}

// Aktuelle Runde inkl. Details für Spiele, die laufen oder vor Kurzem liefen.
export async function liveRound(fetchImpl = fetch, { ids = [] } = {}) {
  const { config } = await getJson('/config.json', fetchImpl);
  const now = Date.now();
  const list = config.events || [];
  const want = list.filter((e) => {
    const t = Date.parse(e.scheduled);
    const s = `${e.status} ${e.status_info?.status}`;
    return ids.includes(e.id) || /live|halftime|pause|1st|2nd/.test(s)
      || (now >= t - 5 * 60e3 && now <= t + 3 * 3600e3);
  });
  const details = await Promise.all(want.slice(0, 10).map(async (e) => {
    const [info, tl, stats] = await Promise.all([
      getJson(`/match/${e.id}/match_info.json`, fetchImpl).then((j) => j.match_info).catch(() => e),
      getJson(`/match/${e.id}/timeline.json`, fetchImpl).then((j) => j.timeline_info || []).catch(() => []),
      getJson(`/match/${e.id}/statistics.json`, fetchImpl).catch(() => null),
    ]);
    return toFixture(info, tl, stats);
  }));
  const detailed = new Set(details.map((d) => d.laolaId));
  return {
    round: config.round,
    list: [...details, ...list.filter((e) => !detailed.has(e.id)).map((e) => toFixture(e))],
  };
}

export async function liveMatch(id, fetchImpl = fetch) {
  const [info, tl, stats] = await Promise.all([
    getJson(`/match/${id}/match_info.json`, fetchImpl).then((j) => j.match_info),
    getJson(`/match/${id}/timeline.json`, fetchImpl).then((j) => j.timeline_info || []).catch(() => []),
    getJson(`/match/${id}/statistics.json`, fetchImpl).catch(() => null),
  ]);
  return toFixture(info, tl, stats);
}
