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
| `library.py` | Bibliotheks-Index: Scan, Messwerte, Suche |
| `planner.py` | Claude durchsucht die Bibliothek und plant die Szenen |
| `core.py` | Plan-Schema, Heuristik, Platzierung, Render |
| `aafexport.py` | AAF-Export (pyaaf2) |
| `ui.py`, `ui/index.html` | lokale Weboberfläche |
| `atmogen.py` | Kommandozeile |
| `BuildScene.lua` | REAPER: Szene aus `*.reaper.lua` aufbauen (Alternative zum AAF) |
| `AtmoImporter.lua` | REAPER: Dateien aus einem Ordner nach Filter importieren |
