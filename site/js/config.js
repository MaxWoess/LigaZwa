export const CONFIG = {
  // Live-Ticker
  defaultInterval: 30, // Sekunden, mit Live-Server
  minInterval: 15,
  fallbackInterval: 60, // ohne Live-Server (Daten von GitHub ändern sich nur alle ~15 Min.)
  liveBeforeKickoff: 3 * 60e3, // ab 3 Min. vor Anpfiff wird abgefragt
  liveMaxWindow: 3 * 3600e3, // danach gilt ein Spiel ohne Endstand als "hängengeblieben"

  newsUrl: 'data/news.json',

  // Zusätzliche Suchbegriffe für den News-Filter. Schlüssel = Teil des Teamnamens auf 2liga.at.
  // Erweitern, falls ein Team in News unter anderem Namen auftaucht.
  aliases: {
    'St. Pölten': ['SKN', 'St. Pölten'],
    'Admira': ['Admira'],
    'FAC': ['FAC', 'Floridsdorfer AC', 'Floridsdorf'],
    'KSV 1919': ['KSV 1919', 'Kapfenberg', 'Kapfenberger SV'],
    'Young Violets': ['Young Violets', 'Austria Wien II'],
    'First Vienna': ['Vienna', 'First Vienna'],
    'Amstetten': ['Amstetten'],
    'Blau-Weiß Linz': ['Blau-Weiß Linz', 'Blau-Weiss Linz', 'BW Linz'],
    'Austria Salzburg': ['Austria Salzburg'],
    'Wacker Innsbruck': ['Wacker Innsbruck', 'Wacker'],
    'Hertha Wels': ['Hertha Wels', 'Hertha'],
    'Voitsberg': ['Voitsberg'],
    'Schwarz-Weiss Bregenz': ['SW Bregenz', 'Schwarz-Weiß Bregenz', 'Bregenz'],
    'Liefering': ['Liefering'],
  },
};
