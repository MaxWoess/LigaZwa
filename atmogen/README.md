# atmogen

Baut aus einem Ordner mit Einzelsounds (Murmeln, Gläser, Teller, Roomtone …) mehrere Atmo-Szenen
unterschiedlicher Dichte. Gedacht für ein interaktives System, in dem ein Regler zwischen den Szenen
überblendet (z. B. „Anzahl Menschen im Raum“).

- **Gleich lang und nahtlos loopbar.** Layer werden zyklisch gecrossfadet, Events laufen über die
  Loop-Grenze weiter.
- **Überblend-fest.** Beds und Layer nutzen in jeder Szene dieselben Segmente und Panoramapositionen.
  Die Szenen unterscheiden sich in Anzahl, Pegel und Event-Dichte.
- **Claude plant.** Claude ordnet jede Datei ein (bed / layer / event / skip) und entwirft pro Szene
  die Mischung. Die Platzierung selbst ist deterministisch (Seed), ein neuer Seed ergibt eine neue Variante.
- **Export.** Stereo-WAV (24 bit) pro Szene, dazu ein AAF (verlinkt oder eingebettet, Mono-Paare oder
  Stereo). Optional gibt es einen REAPER-Bauplan für `BuildScene.lua`. Die Session-Clips sind gebacken
  und klingen exakt wie die WAV.

## Start

```bash
pip install -r requirements.txt
python ui.py            # öffnet http://127.0.0.1:8765 im Browser
```

Im UI gibst du Quellordner, Szenen, Länge und deine Anweisungen an Claude ein, dazu den API-Key.
Ohne Key plant eine einfache Heuristik nach Dateinamen. Die Überblend-Vorschau spielt alle Szenen
synchron ab und simuliert den Regler.

Kommandozeile:

```bash
python atmogen.py ./sounds -o ./out --length 120 --aaf linked \
  --scene "Restaurant, wenig los" --scene "Restaurant, mittel" --scene "Restaurant, voll" \
  --instructions "gehobenes Restaurant, Besteck leise, kaum Lachen"
```

`out/plan.json` lässt sich von Hand anpassen und mit `--plan out/plan.json` (oder im UI unter
„Plan bearbeiten“) neu rendern, ohne Claude erneut zu fragen.

## Dateien

| Datei | Zweck |
|---|---|
| `core.py` | Analyse, Planung, Platzierung, Render |
| `aafexport.py` | AAF-Export (pyaaf2) |
| `ui.py`, `ui/index.html` | lokale Weboberfläche |
| `atmogen.py` | Kommandozeile |
| `BuildScene.lua` | REAPER: Szene aus `*.reaper.lua` aufbauen (Alternative zum AAF) |
| `AtmoImporter.lua` | REAPER: Dateien aus einem Ordner nach Filter importieren |
