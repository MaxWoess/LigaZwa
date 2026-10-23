# LigaZwa – 2. Liga Österreich

Private Web-App (PWA) für die ADMIRAL 2. Liga: **Tabelle (gesamt/heim/auswärts), Spielplan, Live-Ticker, News** (filterbar nach Teams).
Alle Daten kommen von **www.2liga.at**, die App läuft auf GitHub Pages.

## Funktionsweise

| Bereich | Quelle | Aktualisierung |
|---|---|---|
| Tabelle, Spielplan, Spielberichte | 2liga.at → GitHub Action → `data/*.json` | alle 15 Min. |
| News | 2liga.at + Google News + ORF Sport → GitHub Action | alle 15 Min. |
| Live-Ticker | **mit Live-Server:** laola1-Matchcenter (Text-Ticker, Tore, Karten, Wechsel, Statistik), Rückfall 2liga.at | alle 30 s (einstellbar) |
| | ohne Live-Server: Daten der GitHub Action | ca. alle 15 Min. |

Weder 2liga.at noch laola1 erlauben Abfragen direkt aus dem Browser einer fremden Seite (CORS).
Deshalb gibt es für den Echtzeit-Ticker einen kleinen, kostenlosen Cloudflare Worker (`worker/`),
der die Daten holt und mit CORS-Header weiterreicht (10–20 s Cache, damit die Quellen geschont werden).
laola1 nutzt eigene Spiel-IDs; die App ordnet die Spiele über Anstoßzeit und Teamnamen zu.

## Einrichtung

1. **Settings → Pages → Source: „GitHub Actions“** (einmalig).
2. Workflow **Actions → „Deploy & Daten“ → Run workflow** (läuft danach automatisch alle 15 Min.).
3. App öffnen: https://maxwoess.github.io/LigaZwa/ → ⚙ → „Mein Team“ wählen.
   Am Handy: „Zum Startbildschirm hinzufügen“.

### Live-Server (für den 30-Sekunden-Ticker)

1. Kostenloses Konto auf https://dash.cloudflare.com/sign-up anlegen.
   Danach einmal links **„Workers & Pages“** öffnen, damit eine `*.workers.dev`-Adresse angelegt wird.
2. **Account-ID** kopieren (steht auf der „Workers & Pages“-Seite rechts).
3. **API-Token** erstellen: Profil-Symbol → *My Profile* → *API Tokens* → *Create Token* →
   Vorlage **„Edit Cloudflare Workers“** → *Continue to summary* → *Create Token* → kopieren.
4. Im GitHub-Repo: **Settings → Secrets and variables → Actions → New repository secret**
   - `CLOUDFLARE_API_TOKEN` = Token
   - `CLOUDFLARE_ACCOUNT_ID` = Account-ID
5. Workflow einmal manuell starten. Er deployt den Worker und trägt dessen Adresse automatisch in die App ein.

## Anpassen

- News-Quellen: `scraper/feeds.json`
- Alias-Namen für den News-Filter, Intervalle: `site/js/config.js`
- Parser für 2liga.at: `scraper/lib.mjs`, laola1-Umwandlung: `scraper/laola.mjs`
- Alle Runden neu laden: Workflow manuell mit „Alle Runden neu laden“ starten

## Hinweise

- Inoffizielle, private App. Daten, Logos und Texte gehören der Österreichischen Fußball-Bundesliga;
  News-Links führen zur Originalquelle. Abfragen sind bewusst sparsam (15-Min.-Intervall, Worker-Cache).
- Geplante Workflows in öffentlichen Repos pausiert GitHub nach 60 Tagen ohne Repo-Aktivität – dann unter *Actions* wieder aktivieren.
