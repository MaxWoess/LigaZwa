export const CONFIG = {
  // API-Football (api-sports.io). Liga und Saison werden automatisch erkannt,
  // können aber in den Einstellungen unter "Erweitert" überschrieben werden.
  apiBase: 'https://v3.football.api-sports.io',
  country: 'Austria',
  leagueName: /^2\.\s*liga$/i,

  // Live-Ticker
  defaultInterval: 30, // Sekunden
  minInterval: 15,
  quotaReserve: 8, // Anfragen, die für Tabelle/Spielplan übrig bleiben sollen
  liveBeforeKickoff: 3 * 60e3, // ab 3 Min. vor Anpfiff wird gepollt
  matchDuration: 125 * 60e3, // geschätzte Dauer inkl. Pause/Nachspielzeit
  liveMaxWindow: 3 * 3600e3, // danach gilt ein Spiel ohne Endstand als "hängengeblieben"

  // Cache-Laufzeiten
  ttl: {
    league: 7 * 86400e3,
    standings: 2 * 3600e3,
    fixtures: 6 * 3600e3,
  },

  newsUrl: 'data/news.json',

  // Zusätzliche Suchbegriffe für den News-Filter, Schlüssel = Teil des Teamnamens laut API.
  // Erweitern, falls ein Team in News unter anderem Namen auftaucht.
  aliases: {
    'St. Pölten': ['SKN', 'St. Pölten'],
    'Admira': ['Admira'],
    'Floridsdorf': ['FAC', 'Floridsdorfer AC'],
    'Kapfenberg': ['KSV 1919', 'Kapfenberg'],
    'Austria Lustenau': ['Austria Lustenau'],
    'Young Violets': ['Young Violets', 'Austria Wien II'],
  },
};
