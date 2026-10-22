# LigaZwa – 2. Liga Österreich

Private Web-App (PWA) für die ADMIRAL 2. Liga: **Tabelle, Spielplan, Live-Ticker, News** (filterbar nach Teams).
Läuft komplett auf GitHub Pages, ohne eigenen Server.

## Funktionsweise

| Bereich | Quelle | Aktualisierung |
|---|---|---|
| Tabelle, Spielplan | [API-Football](https://www.api-football.com) direkt aus dem Browser | Cache 2 h / 6 h, nach jedem Spielende sofort |
| Live-Ticker | API-Football (`fixtures?ids=…` inkl. Tore, Karten, Wechsel) | alle 30 s (einstellbar), nur während Spiele laufen |
| News | RSS (Google News, ORF Sport) → GitHub Action → `data/news.json` | alle 30 Min. |

- Der **API-Key liegt nur im Browser** (localStorage), nie im Repository.
- Der Ticker pollt nur ab 3 Min. vor Anpfiff bis Spielende und nur, solange die App offen ist.
- **Kontingent-Schutz:** Reicht das Tageskontingent nicht für das eingestellte Intervall bis zum letzten Spiel des Tages, wird das Intervall automatisch verlängert (Anzeige im Live-Tab).
- Ohne Key läuft die App im **Demo-Modus** mit erfundenen Daten.

## Einrichtung

1. Branch nach `main` mergen.
2. **Settings → Pages → Build and deployment → Source: „GitHub Actions“.**
3. Optional, aber empfohlen: **Settings → Secrets and variables → Actions → New repository secret**
   `API_FOOTBALL_KEY` = dein Key. Damit holt die News-Action 1× täglich die Teamliste und sucht zusätzlich gezielt nach News jedes Teams (2 Anfragen/Tag).
4. Workflow „Deploy & News“ läuft automatisch (oder unter *Actions* manuell starten).
5. App öffnen → ⚙ → API-Key eintragen, „Mein Team“ wählen.
   Am Handy: „Zum Startbildschirm hinzufügen“ → läuft wie eine App.

## Wichtig: Kontingent von API-Football

Der Gratis-Plan hat **100 Anfragen/Tag** (pro Key, alle Geräte zusammen). Ein Spieltag mit ~2,5 h Live-Zeit
braucht bei 30 s ≈ 300 Anfragen. Mit dem Gratis-Plan wird der Ticker daher auf ca. 90–120 s gedrosselt.
Für echte 30 s braucht es einen bezahlten Plan (z. B. „Pro“, 7.500 Anfragen/Tag).
Außerdem schränkt der Gratis-Plan teils die verfügbaren Saisonen ein – die App zeigt die Fehlermeldung der API dann oben an.

## Anpassen

- News-Quellen: `scripts/feeds.json`
- Alias-Namen für den News-Filter, Intervalle, Cache-Zeiten: `site/js/config.js`
- Lokal testen: `cd site && python3 -m http.server` → http://localhost:8000

## Hinweise

- Geplante Workflows in öffentlichen Repos pausiert GitHub nach 60 Tagen ohne Repo-Aktivität – dann unter *Actions* wieder aktivieren.
- Logos und Daten stammen von API-Football, News-Links führen zur Originalquelle. Nur für private Nutzung gedacht.
