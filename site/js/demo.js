// Demo-Daten, damit die App ohne API-Key ausprobiert werden kann.
// Alles ist erfunden; zwei Spiele laufen immer "live" und entwickeln sich mit der Uhrzeit.

const TEAMS = [
  'SKN St. Pölten', 'FC Admira', 'Floridsdorfer AC', 'SV Horn', 'Kapfenberger SV', 'SV Lafnitz',
  'SW Bregenz', 'First Vienna FC', 'SV Stripfing', 'FC Liefering', 'SK Austria Klagenfurt', 'Austria Lustenau',
  'SKU Amstetten', 'Young Violets', 'Sturm Graz II', 'Rapid Wien II',
].map((name, i) => ({ id: 9000 + i, name, logo: crest(name, i) }));

const PLAYERS = ['Huber', 'Gruber', 'Bauer', 'Wagner', 'Pichler', 'Steiner', 'Moser', 'Mayer', 'Hofer', 'Leitner', 'Berger', 'Fuchs'];

function crest(name, i) {
  const hue = (i * 47) % 360;
  const initials = name.replace(/\b(FC|SV|SK|SKN|SKU|SW|AC)\b/g, '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="M20 2 36 8v12c0 9-7 15-16 18C11 35 4 29 4 20V8z" fill="hsl(${hue} 60% 42%)"/><text x="20" y="25" font-family="sans-serif" font-size="13" font-weight="700" fill="#fff" text-anchor="middle">${initials}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const SEASON = 2026;
let built = null;

function roundRobin(n) {
  const ids = [...Array(n).keys()];
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i], b = ids[n - 1 - i];
      pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    ids.splice(1, 0, ids.pop());
  }
  return [...rounds, ...rounds.map((p) => p.map(([a, b]) => [b, a]))];
}

function makeEvents(rand, fid, home, away, upTo) {
  const ev = [];
  const n = Math.floor(rand() * 7) + 2;
  for (let i = 0; i < n; i++) {
    const min = Math.floor(rand() * 90) + 1;
    const side = rand() < 0.5 ? home : away;
    const roll = rand();
    const type = roll < 0.42 ? 'Goal' : roll < 0.75 ? 'Card' : 'subst';
    const detail = type === 'Goal' ? (rand() < 0.12 ? 'Penalty' : 'Normal Goal')
      : type === 'Card' ? (rand() < 0.08 ? 'Red Card' : 'Yellow Card') : 'Substitution 1';
    const p = PLAYERS[Math.floor(rand() * PLAYERS.length)];
    ev.push({
      time: { elapsed: min, extra: null },
      team: { id: side.id, name: side.name, logo: side.logo },
      player: { id: fid * 10 + i, name: p },
      assist: { id: null, name: type === 'subst' ? PLAYERS[(i + 3) % PLAYERS.length] : null },
      type, detail, comments: null,
    });
  }
  ev.sort((a, b) => a.time.elapsed - b.time.elapsed);
  return ev.filter((e) => e.time.elapsed <= upTo);
}

function build() {
  const rand = rng(42);
  const schedule = roundRobin(TEAMS.length);
  const now = Date.now();
  // Der aktuelle Spieltag ist heute: Spiele um (jetzt - 38 Min.), (jetzt - 70 Min.) und später.
  const current = 11;
  const fixtures = [];
  let fid = 100000;
  schedule.forEach((pairs, r) => {
    const base = now + (r - current) * 7 * 86400e3;
    pairs.forEach(([h, a], i) => {
      fid++;
      const home = TEAMS[h], away = TEAMS[a];
      let ko;
      if (r === current) {
        ko = [now - 38 * 60e3, now - 70 * 60e3, now - 3 * 3600e3, now - 3 * 3600e3, now + 2 * 3600e3, now + 2 * 3600e3, now + 26 * 3600e3, now + 26 * 3600e3][i];
      } else {
        ko = base + (i < 4 ? -3 * 3600e3 : 22 * 3600e3);
        ko = Math.round(ko / 900e3) * 900e3;
      }
      fixtures.push({ id: fid, ko, home, away, round: r + 1, seed: Math.floor(rand() * 1e9) });
    });
  });
  built = { fixtures };
}

function snapshot(f) {
  const now = Date.now();
  const rand = rng(f.seed);
  const minsPlayed = (now - f.ko) / 60e3;
  let short = 'NS', long = 'Not Started', elapsed = null, upTo = -1;
  if (minsPlayed >= 0) {
    if (minsPlayed < 45) { short = '1H'; long = 'First Half'; elapsed = Math.floor(minsPlayed) + 1; }
    else if (minsPlayed < 60) { short = 'HT'; long = 'Halftime'; elapsed = 45; }
    else if (minsPlayed < 107) { short = '2H'; long = 'Second Half'; elapsed = Math.min(90, Math.floor(minsPlayed - 15) + 1); }
    else { short = 'FT'; long = 'Match Finished'; elapsed = 90; }
    upTo = elapsed;
  }
  const events = makeEvents(rand, f.id, f.home, f.away, upTo);
  const goals = (team) => events.filter((e) => e.type === 'Goal' && e.team.id === team.id).length;
  const started = short !== 'NS';
  const gh = started ? goals(f.home) : null, ga = started ? goals(f.away) : null;
  return {
    fixture: {
      id: f.id, referee: null, timezone: 'Europe/Vienna', date: new Date(f.ko).toISOString(), timestamp: f.ko / 1000,
      venue: { name: `${f.home.name.split(' ').at(-1)}-Arena`, city: null },
      status: { long, short, elapsed, extra: null },
    },
    league: { id: 0, name: '2. Liga', season: SEASON, round: `Regular Season - ${f.round}` },
    teams: {
      home: { ...f.home, winner: short === 'FT' ? (gh > ga ? true : gh < ga ? false : null) : null },
      away: { ...f.away, winner: short === 'FT' ? (ga > gh ? true : ga < gh ? false : null) : null },
    },
    goals: { home: gh, away: ga },
    score: { halftime: { home: null, away: null }, fulltime: { home: gh, away: ga } },
    events,
  };
}

function standings(list) {
  const t = new Map(TEAMS.map((x) => [x.id, { team: x, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, form: '' }]));
  for (const f of list) {
    if (f.fixture.status.short !== 'FT') continue;
    const h = t.get(f.teams.home.id), a = t.get(f.teams.away.id);
    const gh = f.goals.home, ga = f.goals.away;
    for (const [s, gf, gA] of [[h, gh, ga], [a, ga, gh]]) {
      s.p++; s.gf += gf; s.ga += gA;
      const r = gf > gA ? 'W' : gf === gA ? 'D' : 'L';
      s[r === 'W' ? 'w' : r === 'D' ? 'd' : 'l']++;
      s.form = (s.form + r).slice(-5);
    }
  }
  const rows = [...t.values()].sort((x, y) => (3 * y.w + y.d) - (3 * x.w + x.d) || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
  return rows.map((s, i) => ({
    rank: i + 1, team: s.team, points: 3 * s.w + s.d, goalsDiff: s.gf - s.ga, form: s.form,
    description: i === 0 ? 'Promotion - Bundesliga' : i >= rows.length - 2 ? 'Relegation - Regionalliga' : null,
    all: { played: s.p, win: s.w, draw: s.d, lose: s.l, goals: { for: s.gf, against: s.ga } },
  }));
}

export const demoProvider = {
  name: 'demo',
  async getLeague() {
    if (!built) build();
    return { id: 0, name: '2. Liga (Demo)', logo: null, season: SEASON };
  },
  async getStandings() {
    return { rows: standings(built.fixtures.map(snapshot)) };
  },
  async getFixtures() {
    return { list: built.fixtures.map((f) => { const s = snapshot(f); delete s.events; return s; }) };
  },
  async getFixturesByIds(ids) {
    return built.fixtures.filter((f) => ids.includes(f.id)).map(snapshot);
  },
  async getStatus() {
    return { plan: 'Demo', day: '', used: 0, limit: null, remaining: null };
  },
};

export function demoNews() {
  const now = Date.now();
  const t = (i) => TEAMS[i].name;
  return {
    updated: new Date(now).toISOString(),
    items: [
      [`${t(0)} gewinnt Spitzenspiel gegen ${t(1)}`, 'Demo-Zeitung', 40],
      [`Trainerwechsel bei ${t(4)}: Neuer Coach präsentiert`, 'Demo-Sport', 180],
      [`${t(7)} verlängert mit Kapitän`, 'Demo-Zeitung', 400],
      [`2. Liga: Die Analyse zum ${11}. Spieltag`, 'Demo-Portal', 900],
      [`${t(13)}: Junges Team überrascht weiter`, 'Demo-Sport', 1500],
      [`Stadionfrage bei ${t(6)} weiter offen`, 'Demo-Portal', 2800],
    ].map(([title, source, mins]) => ({
      title, source, link: '#news', date: new Date(now - mins * 60e3).toISOString(), summary: 'Demo-Meldung – im echten Betrieb kommen die News über die GitHub Action aus RSS-Feeds.',
    })),
  };
}
