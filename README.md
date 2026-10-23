# LigaZwa – 2. Liga Österreich

Private Web-App (PWA) für die ADMIRAL 2. Liga: **Tabelle (gesamt/heim/auswärts), Spielplan, Live-Ticker, News** (filterbar nach Teams).
Alle Daten kommen von **www.2liga.at**, die App läuft auf GitHub Pages.

## Funktionsweise

| Bereich | Quelle | Aktualisierung |
|---|---|---|
| Tabelle, Spielplan, Spielberichte | 2liga.at → GitHub Action → `data/*.json` | alle 15 Min. |
| News | 2liga.at + Google News + ORF Sport → GitHub Action | alle 15 Min. |
| Live-Ticker | **mit Live-Server:** Cloudflare Worker liest das 2liga.at-Matchcenter | alle 30 s (einstellbar) |
| | ohne Live-Server: Daten der GitHub Action | ca. alle 15 Min. |

Der Browser darf 2liga.at nicht direkt abfragen (CORS). Deshalb gibt es für den Echtzeit-Ticker
einen kleinen, kostenlosen Cloudflare Worker (`worker/`), der die Seite ausliest und als JSON liefert
(mit 20 s Cache, damit 2liga.at geschont wird).

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
- Parser für 2liga.at: `scraper/lib.mjs` (falls sich die Seite ändert, hier anpassen)
- Alle Runden neu laden: Workflow manuell mit „Alle Runden neu laden“ starten

## Hinweise

- Inoffizielle, private App. Daten, Logos und Texte gehören der Österreichischen Fußball-Bundesliga;
  News-Links führen zur Originalquelle. Abfragen sind bewusst sparsam (15-Min.-Intervall, Worker-Cache).
- Geplante Workflows in öffentlichen Repos pausiert GitHub nach 60 Tagen ohne Repo-Aktivität – dann unter *Actions* wieder aktivieren.
