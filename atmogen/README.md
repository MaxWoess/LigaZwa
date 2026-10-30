# atmogen

Du beschreibst eine Atmo („gehobenes Restaurant am Abend, leises Besteck, kein Lachen“), und Claude
sucht die passenden Sounds aus deiner ganzen Bibliothek. atmogen baut daraus mehrere Szenen
unterschiedlicher Dichte. Gedacht ist das für ein interaktives System, in dem ein Regler zwischen den
Szenen überblendet (z. B. „Anzahl Menschen im Raum“).

- **Bibliothek.** Einmal den ganzen Ordner inklusive Unterordner analysieren lassen. Das läuft
  parallel, der Index liegt in `~/.atmogen/index/`, beim nächsten Mal kommen nur neue Dateien dazu.
  Dateien ohne Endung (z. B. aus einem Unity-Cache) werden am Dateikopf erkannt.
- **Claude sucht selbst.** Claude bekommt die Ordnerübersicht und Werkzeuge zum Durchsuchen
  (Name, Ordner, Länge, durchgehend oder vereinzelt). Es wählt Beds, Layer und Event-Varianten aus
  und plant jede Szene. Die Suchschritte erscheinen live im UI.
- **Gleich lang und nahtlos loopbar.** Layer werden zyklisch gecrossfadet, Events laufen über die
  Loop-Grenze weiter.
- **Überblend-fest.** Beds und Layer nutzen in jeder Szene dieselben Segmente und Panoramapositionen.
- **Export.** Stereo-WAV (24 bit) pro Szene, dazu ein AAF (verlinkt oder eingebettet, Mono-Paare oder
  Stereo). Optional gibt es einen REAPER-Bauplan für `BuildScene.lua`. Die Session-Clips sind
  gebacken und klingen exakt wie die WAV.

## Optional: Inhaltsanalyse mit CLAP

CLAP ist ein Audio-Text-Modell, kostenlos und lokal auf der CPU. Damit kann Claude zusätzlich
**nach Klang suchen** („gedämpftes Murmeln in einem kleinen Raum“), **ähnliche Varianten** zu einem
guten Sound finden und **prüfen, ob die gewählten Sounds zusammenpassen** (gleicher Raum, ähnlicher
Charakter). Jede Datei bekommt automatisch Schlagwörter („klingt nach …“) und eine Einschätzung des
Raums.

```bash
pip install -r requirements-clap.txt   # PyTorch (CPU) + transformers
```

Im UI das Häkchen „Inhaltsanalyse mit CLAP“ setzen und „Analysieren“ klicken. Beim ersten Mal lädt das
Modell (`laion/larger_clap_general`, rund 800 MB). Die Analyse ist einmalig und deutlich langsamer als
der normale Scan; danach liegt sie im Index, und Abbrüche verlieren höchstens die letzten 200 Dateien.
Die Analyse ist grob: Sie unterscheidet „Restaurant“ von „Wald“ und „hallig“ von „trocken“, ersetzt aber
keine guten Dateinamen.

## Start

```bash
pip install -r requirements.txt
python ui.py            # öffnet http://127.0.0.1:8765 im Browser
```

1. Bibliotheksordner wählen und „Analysieren“ klicken (nur beim ersten Mal und nach Änderungen nötig).
2. Atmo beschreiben, Szenen und Länge festlegen, API-Key eintragen. Optional lässt sich die Suche auf
   einen Unterordner beschränken.
3. „Atmo zusammenstellen“ klicken: Claude sucht und plant. „Rendern“ erzeugt WAVs und AAF. Die
   Überblend-Vorschau simuliert deinen Regler.

`plan.json` im Ausgabeordner lässt sich bearbeiten (UI: „Plan bearbeiten“) und ohne erneute
Claude-Anfrage neu rendern. „Neue Variante“ verteilt die Events neu.

Kommandozeile:

```bash
python atmogen.py scan D:/Sounds
python atmogen.py make D:/Sounds "Gehobenes Restaurant am Abend, kein Lachen" -o out --aaf linked \
  --scene "wenig los" --scene "mittel" --scene "voll"
```

## Dateien

| Datei | Zweck |
|---|---|
| `library.py` | Bibliotheks-Index: Scan, Messwerte, Suche, Klangsuche |
| `clap.py` | optionale Inhaltsanalyse mit CLAP |
| `planner.py` | Claude durchsucht die Bibliothek und plant die Szenen |
| `core.py` | Plan-Schema, Heuristik, Platzierung, Render |
| `aafexport.py` | AAF-Export (pyaaf2) |
| `ui.py`, `ui/index.html` | lokale Weboberfläche |
| `atmogen.py` | Kommandozeile |
| `BuildScene.lua` | REAPER: Szene aus `*.reaper.lua` aufbauen (Alternative zum AAF) |
| `AtmoImporter.lua` | REAPER: Dateien aus einem Ordner nach Filter importieren |
